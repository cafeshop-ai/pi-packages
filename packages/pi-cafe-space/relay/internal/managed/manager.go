// Package managed owns only Pi subprocesses it starts. Pi owns all sessions,
// provider credentials, transcripts and tools; this registry never edits JSONL.
package managed

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
)

// ponytail: bounded registry, no automatic deletion; add explicit archive/delete
// with a durable idempotency tombstone before growing beyond 100 saved sessions.
const maxSaved = 100
const maxActive = 8

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
var sessionID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Room string `json:"room"`
	Cwd  string `json:"cwd"`
}
type Config struct {
	Node      string `json:"node"`
	CLI       string `json:"cli"`
	Extension string `json:"extension"`
	AgentDir  string `json:"agentDir"`
	StateDir  string `json:"stateDir"`
	// Exact environment for native Pi, explicitly configured locally. Never sent
	// to Web or copied from an arbitrary browser payload or another live Pi.
	Env      map[string]string `json:"env"`
	Projects []Project         `json:"projects"`
}
type Record struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Cwd       string `json:"cwd"`
	Room      string `json:"room"`
	Name      string `json:"name"`
	Title     string `json:"title,omitempty"`
	HostID    string `json:"hostId"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	// Set only on inventory copies from the current owned RPC process.
	Execution protocol.Object `json:"execution,omitempty"`
}
type Request struct {
	Room      string `json:"room"`
	Operation string `json:"operation"`
	ID        string `json:"id,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
	Name      string `json:"name,omitempty"`
}
type process struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	done    chan struct{}
	release func()
	ready   bool
	naming  bool
	execution rpcExecution
}
type Manager struct {
	mu                  sync.Mutex
	cfg                 Config
	relayURL, hostToken string
	records             []Record
	active              map[string]*process
	closing             bool
	unlock              func()
	closeOnce           sync.Once
	closeDone           chan struct{}
}

func readJSON(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 256*1024 {
		return errors.New("invalid managed configuration/registry")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.DisallowUnknownFields()
	if err = d.Decode(value); err != nil {
		return errors.New("invalid managed configuration/registry")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("invalid managed configuration/registry")
	}
	return nil
}
func canonical(path string, directory bool) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("managed paths must be absolute")
	}
	real, err := resolvedPath(path)
	if err != nil {
		return "", errors.New("managed path unavailable")
	}
	info, err := os.Stat(real)
	if err != nil || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return "", errors.New("invalid managed path")
	}
	return filepath.Clean(real), nil
}
func Load(path, relayURL, token string) (*Manager, error) {
	var cfg Config
	if err := readJSON(path, &cfg); err != nil {
		return nil, err
	}
	if len(cfg.Projects) == 0 || len(cfg.Projects) > 16 || len(cfg.Env) > 64 {
		return nil, errors.New("invalid managed project/environment limits")
	}
	for key, value := range cfg.Env {
		if strings.ContainsAny(key, "=\x00") || strings.HasPrefix(strings.ToUpper(key), "PI_COLLAB_") || strings.EqualFold(key, "NODE_OPTIONS") || strings.EqualFold(key, "NODE_PATH") || len(value) > 32768 {
			return nil, errors.New("invalid managed environment")
		}
	}
	for _, field := range []*string{&cfg.Node, &cfg.CLI, &cfg.Extension} {
		real, err := canonical(*field, false)
		if err != nil {
			return nil, err
		}
		*field = real
	}
	for _, field := range []*string{&cfg.AgentDir, &cfg.StateDir} {
		real, err := canonical(*field, true)
		if err != nil {
			return nil, err
		}
		*field = real
	}
	seen := map[string]bool{}
	for i, p := range cfg.Projects {
		if !identifier.MatchString(p.ID) || !identifier.MatchString(p.Room) || !validName(p.Name) || seen[p.ID] {
			return nil, errors.New("invalid managed project")
		}
		seen[p.ID] = true
		real, err := canonical(p.Cwd, true)
		if err != nil {
			return nil, err
		}
		cfg.Projects[i].Cwd = real
	}
	unlock, err := lockRegistry(filepath.Join(cfg.StateDir, "registry.lock"))
	if err != nil {
		return nil, errors.New("managed registry is already owned or unavailable")
	}
	loaded := false
	defer func() {
		if !loaded {
			unlock()
		}
	}()
	m := &Manager{cfg: cfg, relayURL: relayURL, hostToken: token, active: map[string]*process{}, unlock: unlock}
	if err := readJSON(filepath.Join(cfg.StateDir, "registry.json"), &m.records); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(m.records) > maxSaved {
		return nil, errors.New("managed registry capacity exceeded")
	}
	ids := map[string]bool{}
	for i, r := range m.records {
		p := m.project(r.ProjectID, r.Room)
		if !sessionID.MatchString(r.ID) || p == nil || r.Cwd != p.Cwd || !validName(r.Name) || (r.Title != "" && !validName(r.Title)) || ids[r.ID] || r.HostID != "managed-"+r.ID {
			return nil, errors.New("invalid managed registry record")
		}
		ids[r.ID] = true
		m.records[i].Status = "stopped"
		m.records[i].Error = ""
		m.records[i].Execution = nil
	}
	loaded = true
	return m, nil
}
func validName(name string) bool {
	if strings.TrimSpace(name) == "" || len(utf16.Encode([]rune(name))) > 256 {
		return false
	}
	for _, r := range name {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func (m *Manager) project(id, room string) *Project {
	for i := range m.cfg.Projects {
		p := &m.cfg.Projects[i]
		if p.ID == id && p.Room == room {
			return p
		}
	}
	return nil
}
func (m *Manager) save() error {
	records:=append([]Record(nil),m.records...)
	for i:=range records{records[i].Execution=nil}
	b, err := json.Marshal(records)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(m.cfg.StateDir, "registry-*.tmp")
	if err != nil {
		return err
	}
	path := f.Name()
	defer os.Remove(path)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(path, filepath.Join(m.cfg.StateDir, "registry.json"))
}
func (m *Manager) inventory(room string) any {
	projects := []Project{}
	records := []Record{}
	for _, p := range m.cfg.Projects {
		if p.Room == room {
			projects = append(projects, p)
		}
	}
	for _, r := range m.records {
		if r.Room == room {
			r.Execution=nil
			if p:=m.active[r.ID];p!=nil&&p.ready&&r.Status=="ready"{r.Execution=p.execution.snapshot()}
			records = append(records, r)
		}
	}
	return map[string]any{"projects": projects, "sessions": records, "maxActive": maxActive}
}

// Execute never waits for child readiness under the mutex. Status is explicit;
// Web waits for both the ready process AND its authoritative Relay snapshot.
func (m *Manager) Execute(q Request) (any, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return nil, "MANAGER_STOPPING"
	}
	if !identifier.MatchString(q.Room) {
		return nil, "INVALID_REQUEST"
	}
	if q.Operation == "list" {
		if q.ID != "" || q.ProjectID != "" || q.Name != "" {
			return nil, "INVALID_REQUEST"
		}
		return m.inventory(q.Room), ""
	}
	if !sessionID.MatchString(q.ID) {
		return nil, "INVALID_REQUEST"
	}
	index := -1
	for i, r := range m.records {
		if r.ID == q.ID {
			index = i
			break
		}
	}
	if q.Operation == "create" {
		if !validName(q.Name) || m.project(q.ProjectID, q.Room) == nil {
			return nil, "PROJECT_UNAVAILABLE"
		}
		if index >= 0 {
			r := m.records[index]
			if r.Room != q.Room || r.ProjectID != q.ProjectID || r.Name != strings.TrimSpace(q.Name) {
				return nil, "REQUEST_CONFLICT"
			}
			return r, ""
		}
		if len(m.records) >= maxSaved || len(m.active) >= maxActive {
			return nil, "MANAGED_LIMIT"
		}
		r := Record{ID: q.ID, ProjectID: q.ProjectID, Cwd: m.project(q.ProjectID, q.Room).Cwd, Room: q.Room, Name: strings.TrimSpace(q.Name), HostID: "managed-" + q.ID, Status: "stopped"}
		m.records = append(m.records, r)
		index = len(m.records) - 1
		// Persist the idempotency identity before any child can start. A lost HTTP
		// response or Relay restart cannot create a duplicate session for this ID.
		if err := m.save(); err != nil {
			m.records = m.records[:index]
			return nil, "REGISTRY_UNAVAILABLE"
		}
	} else if q.Operation == "open" || q.Operation == "close" {
		if q.ProjectID != "" || q.Name != "" {
			return nil, "INVALID_REQUEST"
		}
		if index < 0 || m.records[index].Room != q.Room {
			return nil, "SESSION_NOT_FOUND"
		}
	} else {
		return nil, "INVALID_REQUEST"
	}
	r := &m.records[index]
	if q.Operation == "close" {
		if p := m.active[q.ID]; p != nil {
			m.stop(p, q.ID)
		}
		return *r, ""
	}
	if p := m.active[q.ID]; p != nil {
		return *r, ""
	}
	if len(m.active) >= maxActive {
		return nil, "MANAGED_LIMIT"
	}
	if err := m.start(index, q.Operation == "create"); err != nil {
		r.Status = "failed"
		r.Error = "MANAGED_START_FAILED"
		return *r, ""
	}
	return *r, ""
}
func (m *Manager) stop(p *process, id string) {
	for i := range m.records {
		if m.records[i].ID == id {
			if m.records[i].Status == "stopping" {
				return
			}
			m.records[i].Status = "stopping"
		}
	}
	io.WriteString(p.stdin, "{\"id\":\"managed-close\",\"type\":\"get_state\"}\n")
	go func() {
		select {
		case <-p.done:
		case <-time.After(8 * time.Second):
			m.mu.Lock()
			defer m.mu.Unlock()
			for _, r := range m.records {
				if r.ID == id && r.Status == "stopping" {
					p.release()
				}
			}
		}
	}()
}
func (m *Manager) start(index int, fresh bool) error {
	r := &m.records[index]
	project := m.project(r.ProjectID, r.Room)
	// The configured, canonical directory must not have been replaced by a link.
	cwd, err := canonical(project.Cwd, true)
	if err != nil || cwd != project.Cwd {
		return errors.New("project changed")
	}
	sessions := filepath.Join(m.cfg.StateDir, "sessions", project.ID)
	if err = os.MkdirAll(sessions, 0700); err != nil {
		return err
	}
	real, err := canonical(sessions, true)
	if err != nil || real != sessions {
		return errors.New("session directory changed")
	}
	args := []string{m.cfg.CLI, "--mode", "rpc", "--offline", "--no-extensions", "-e", m.cfg.Extension, "--no-approve", "--no-themes", "--session-dir", sessions, "--session-id", r.ID}
	if fresh {
		args = append(args, "--name", r.Name)
	}
	cmd := exec.Command(m.cfg.Node, args...)
	cmd.Dir = cwd
	for k, v := range m.cfg.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Env = append(cmd.Env, "PI_CODING_AGENT_DIR="+m.cfg.AgentDir, "PI_OFFLINE=1", "PI_TELEMETRY=0", "PI_COLLAB_ENABLED=1", "PI_COLLAB_RELAY_URL="+m.relayURL, "PI_COLLAB_ROOM="+r.Room, "PI_COLLAB_PEER_ID="+r.HostID, "PI_COLLAB_HOST_TOKEN="+m.hostToken, "PI_COLLAB_MANAGED=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return err
	}
	cmd.Stderr = io.Discard
	release, err := startOwnedProcess(cmd)
	if err != nil {
		stdin.Close()
		stdout.Close()
		return err
	}
	stdin = newBoundedInput(stdin, release)
	p := &process{cmd: cmd, stdin: stdin, done: make(chan struct{}), release: release}
	m.active[r.ID] = p
	r.Status = "starting"
	r.Error = ""
	id := r.ID
	go m.read(p, id, stdout)
	go func() {
		select {
		case <-time.After(30 * time.Second):
			m.mu.Lock()
			if m.active[id] == p && !p.ready {
				m.fail(id, "MANAGED_START_TIMEOUT")
				stdin.Close()
				release()
			}
			m.mu.Unlock()
		case <-p.done:
		}
	}()
	// get_state is not a prompt, and is answered only after native startup.
	if _, err = io.WriteString(stdin, "{\"id\":\"managed-ready\",\"type\":\"get_state\"}\n"); err != nil {
		stdin.Close()
	}
	return nil
}
func (m *Manager) fail(id, code string) {
	for i := range m.records {
		if m.records[i].ID == id {
			m.records[i].Status = "failed"
			m.records[i].Error = code
			return
		}
	}
}
func (m *Manager) read(p *process, id string, stdout io.Reader) {
	// Drain the full RPC stream, but retain only bounded metadata frames. Native
	// image/tool events can legitimately exceed this limit; never kill a Pi just
	// because a transcript event is large (Relay carries the actual conversation).
	reader := bufio.NewReaderSize(stdout, 64*1024)
	var line []byte
	skipping := false
	for {
		part, prefix, err := reader.ReadLine()
		if err != nil {
			break
		}
		if len(line)+len(part) > 2*1024*1024 {
			skipping = true
			line = nil
		}
		if !skipping {
			line = append(line, part...)
		}
		if prefix {
			continue
		}
		if skipping {
			skipping = false
			continue
		}
		var event rpcEvent
		parseErr := json.Unmarshal(line, &event)
		line = line[:0]
		if parseErr != nil {
			continue
		}
		m.mu.Lock()
		if m.active[id]==p { p.execution.observe(event) }
		m.mu.Unlock()
		if event.Type == "response" && (event.ID == "managed-ready" || event.ID == "managed-close") {
			m.mu.Lock()
			for i := range m.records {
				r := &m.records[i]
				if r.ID != id {
					continue
				}
				if !event.Success || event.Data.SessionID != id {
					m.fail(id, "MANAGED_START_FAILED")
					p.stdin.Close()
					break
				}
				if event.Data.SessionName == "" && event.ID == "managed-ready" && !p.naming {
					p.naming = true
					title := r.Title
					if title == "" {
						title = r.Name
					}
					b, _ := json.Marshal(map[string]string{"id": "managed-name", "type": "set_session_name", "name": title})
					p.stdin.Write(append(b, '\n'))
					io.WriteString(p.stdin, "{\"id\":\"managed-ready\",\"type\":\"get_state\"}\n")
					break
				}
				if !validName(event.Data.SessionName) {
					m.fail(id, "MANAGED_START_FAILED")
					p.stdin.Close()
					break
				}
				// Pi deliberately keeps empty-session setup in memory. Retain only its
				// display name on graceful close; never manufacture or rewrite JSONL.
				// ponytail: crash before the first turn follows Pi's unsaved setup rules;
				// add native metadata events if crash-durable empty-session rename is needed.
				previous := r.Title
				r.Title = event.Data.SessionName
				if previous != r.Title {
					if err := m.save(); err != nil {
						r.Title = previous
						r.Error = "REGISTRY_UNAVAILABLE"
						if event.ID == "managed-close" {
							r.Status = "ready"
						} else {
							r.Status = "failed"
							p.stdin.Close()
						}
						break
					}
				}
				if event.ID == "managed-close" {
					p.stdin.Close()
				} else {
					p.ready = true
					if r.Status == "starting" {
						r.Status = "ready"
					}
				}
			}
			m.mu.Unlock()
		}
		// No arbitrary extensions load in managed mode. Any native dialog still
		// encountered is explicitly cancelled, never silently approved or left hung.
		if event.Type == "extension_ui_request" && (event.Method == "confirm" || event.Method == "select" || event.Method == "input" || event.Method == "editor") {
			b, _ := json.Marshal(map[string]any{"type": "extension_ui_response", "id": event.ID, "cancelled": true})
			p.stdin.Write(append(b, '\n'))
		}
	}
	p.stdin.Close()
	go func() {
		select {
		case <-p.done:
		case <-time.After(8 * time.Second):
			p.release()
		}
	}()
	err := p.cmd.Wait()
	p.stdin.Close()
	p.release()
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.active, id)
	for i := range m.records {
		r := &m.records[i]
		if r.ID == id && r.Status != "failed" {
			if r.Status != "stopping" && (err != nil || !p.ready) {
				r.Status = "failed"
				r.Error = "MANAGED_PROCESS_EXITED"
			} else {
				r.Status = "stopped"
			}
		}
	}
	close(p.done)
}
func (m *Manager) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = m.CloseContext(ctx)
}

// Cancellation bounds the caller's wait. The registry remains locked until
// cleanup has actually reaped our processes, not merely until a timer fires.
func (m *Manager) CloseContext(ctx context.Context) error {
	m.closeOnce.Do(func() {
		m.closeDone = make(chan struct{})
		go func() { defer close(m.closeDone); m.closeAll() }()
	})
	select { case <-m.closeDone: return nil; case <-ctx.Done(): return ctx.Err() }
}
func (m *Manager) closeAll() {
	defer func() { if m.unlock != nil { m.unlock() } }()
	m.mu.Lock()
	m.closing = true
	processes := []*process{}
	for id, p := range m.active {
		processes = append(processes, p)
		m.stop(p, id)
	}
	m.mu.Unlock()
	deadline := time.After(8 * time.Second)
	for _, p := range processes {
		select {
		case <-p.done:
		case <-deadline:
			for _, x := range processes {
				x.release()
			}
			for _, x := range processes {
				<-x.done
			}
			return
		}
	}
}
func (m *Manager) Handler(token string, origins auth.Origins) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fail := func(status int, code string) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]string{"error": code})
		}
		if r.Method != "POST" {
			w.Header().Set("Allow", "POST")
			fail(405, "METHOD_NOT_ALLOWED")
			return
		}
		if r.URL.RawQuery != "" || r.URL.RawPath != "" || r.Header.Get("Origin") == "" || !origins.Allowed(r) {
			fail(403, "ORIGIN_DENIED")
			return
		}
		headers := r.Header.Values("Authorization")
		if len(headers) != 1 || !strings.HasPrefix(headers[0], "Bearer ") || !auth.TokenMatches(strings.TrimPrefix(headers[0], "Bearer "), token) {
			fail(401, "UNAUTHORIZED")
			return
		}
		if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
			fail(415, "INVALID_REQUEST")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		defer r.Body.Close()
		var q Request
		d := json.NewDecoder(r.Body)
		d.DisallowUnknownFields()
		if d.Decode(&q) != nil || d.Decode(new(any)) != io.EOF {
			fail(400, "INVALID_REQUEST")
			return
		}
		data, code := m.Execute(q)
		if code != "" {
			fail(409, code)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(data)
	})
}
