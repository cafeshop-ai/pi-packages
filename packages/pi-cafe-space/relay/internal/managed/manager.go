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
	"runtime"
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
var agentSessionID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Room string `json:"room"`
	Cwd  string `json:"cwd"`
}
type ACPConfig struct {
	Root   string            `json:"root"`
	Codex  string            `json:"codex"`
	Socket string            `json:"socket,omitempty"`
	Env    map[string]string `json:"env,omitempty"`
}
type AgentSession struct {
	ID        string `json:"-"`
	Key       string `json:"key"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	Status    string `json:"status"`
}
type Config struct {
	Node      string     `json:"node"`
	CLI       string     `json:"cli"`
	Extension string     `json:"extension"`
	AgentDir  string     `json:"agentDir"`
	StateDir  string     `json:"stateDir"`
	ACP       *ACPConfig `json:"acp,omitempty"`
	// Exact environments are explicitly configured locally. Never sent to Web
	// or copied from an arbitrary browser payload or another live agent.
	Env      map[string]string `json:"env"`
	Projects []Project         `json:"projects"`
}
type Record struct {
	ID             string `json:"id"`
	ProjectID      string `json:"projectId"`
	Cwd            string `json:"cwd"`
	Room           string `json:"room"`
	Name           string `json:"name"`
	Title          string `json:"title,omitempty"`
	HostID         string `json:"hostId"`
	Status         string `json:"status"`
	Error          string `json:"error,omitempty"`
	Agent          string `json:"agent,omitempty"`
	AgentMode      string `json:"agentMode,omitempty"`
	AgentSessionID string `json:"-"`
	AgentTargetKey string `json:"-"`
	AgentAttempted bool   `json:"-"`
	// Set only on inventory copies from the current owned RPC process.
	Execution protocol.Object `json:"execution,omitempty"`
}
type Request struct {
	Room      string `json:"room"`
	Operation string `json:"operation"`
	ID        string `json:"id,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
	Name      string `json:"name,omitempty"`
	Agent     string `json:"agent,omitempty"`
	TargetKey string `json:"targetKey,omitempty"`
}
type registryRecord struct {
	Record
	AgentSessionID string `json:"agentSessionId,omitempty"`
	AgentTargetKey string `json:"agentTargetKey,omitempty"`
	AgentAttempted bool   `json:"agentAttempted,omitempty"`
}
type process struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	done      chan struct{}
	release   func()
	ready     bool
	naming    bool
	kind      string
	agentMode string
	execution rpcExecution
}
type Manager struct {
	mu                       sync.Mutex
	targetsMu                sync.Mutex
	queryCancels             map[uint64]context.CancelFunc
	queryNext                uint64
	queries                  sync.WaitGroup
	cfg                      Config
	acpRunner, targetsRunner string
	relayURL, hostToken      string
	records                  []Record
	active                   map[string]*process
	targets                  map[string]targetCache
	closing                  bool
	unlock                   func()
	closeOnce                sync.Once
	closeDone                chan struct{}
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
	if err := validateEnvironment(cfg.Env); err != nil {
		return nil, err
	}
	if cfg.ACP != nil {
		if err := validateEnvironment(cfg.ACP.Env); err != nil {
			return nil, err
		}
		if err := validateACPRuntime(cfg.ACP.Root); err != nil {
			return nil, err
		}
		for _, field := range []*string{&cfg.ACP.Root, &cfg.ACP.Codex} {
			directory := field == &cfg.ACP.Root
			real, err := canonical(*field, directory)
			if err != nil {
				return nil, errors.New("invalid ACP runtime path")
			}
			*field = real
		}
		if !validACPSocketPath(cfg.ACP.Socket) {
			return nil, errors.New("invalid ACP socket path")
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
	acpRunner, targetsRunner := "", ""
	if cfg.ACP != nil {
		packageRoot := filepath.Dir(filepath.Dir(filepath.Dir(cfg.Extension)))
		var err error
		acpRunner, err = canonical(filepath.Join(packageRoot, "scripts", "acp", "space-run.mjs"), false)
		if err != nil {
			return nil, errors.New("ACP runtime scripts are unavailable")
		}
		targetsRunner, err = canonical(filepath.Join(packageRoot, "scripts", "acp", "targets.mjs"), false)
		if err != nil {
			return nil, errors.New("ACP target listing is unavailable")
		}
	}
	loaded := false
	defer func() {
		if !loaded {
			unlock()
		}
	}()
	m := &Manager{cfg: cfg, acpRunner: acpRunner, targetsRunner: targetsRunner, relayURL: relayURL, hostToken: token, active: map[string]*process{}, targets: map[string]targetCache{}, queryCancels: map[uint64]context.CancelFunc{}, unlock: unlock}
	var stored []registryRecord
	if err := readJSON(filepath.Join(cfg.StateDir, "registry.json"), &stored); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	m.records = make([]Record, len(stored))
	for i, record := range stored {
		m.records[i] = record.Record
		m.records[i].AgentSessionID = record.AgentSessionID
		m.records[i].AgentTargetKey = record.AgentTargetKey
		m.records[i].AgentAttempted = record.AgentAttempted
	}
	if len(m.records) > maxSaved {
		return nil, errors.New("managed registry capacity exceeded")
	}
	ids := map[string]bool{}
	recovered := false
	for i, r := range m.records {
		if r.Agent == "" {
			r.Agent = "pi"
		}
		p := m.project(r.ProjectID, r.Room)
		if !sessionID.MatchString(r.ID) || p == nil || r.Cwd != p.Cwd || !validName(r.Name) || (r.Title != "" && !validName(r.Title)) || ids[r.ID] || r.HostID != "managed-"+r.ID || (r.Agent != "pi" && r.Agent != "codex-acp") || (r.Agent == "pi" && (r.AgentMode != "" || r.AgentSessionID != "" || r.AgentTargetKey != "" || r.AgentAttempted)) || (r.Agent == "codex-acp" && ((r.AgentMode != "new" && r.AgentMode != "attach") || (r.AgentMode == "attach" && (!agentSessionID.MatchString(r.AgentSessionID) || !targetKeyPattern.MatchString(r.AgentTargetKey) || r.AgentAttempted)) || (r.AgentMode == "new" && (r.AgentTargetKey != "" || r.AgentSessionID != "" && (!agentSessionID.MatchString(r.AgentSessionID) || !r.AgentAttempted))))) {
			return nil, errors.New("invalid managed registry record")
		}
		ids[r.ID] = true
		m.records[i].Agent = r.Agent
		m.records[i].Status = "stopped"
		m.records[i].Error = ""
		if r.Agent == "codex-acp" && r.AgentMode == "new" && r.AgentAttempted && r.AgentSessionID == "" {
			if session, err := readACPState(agentStateDirectory(cfg.StateDir, r.ID)); err == nil {
				m.records[i].AgentSessionID = session
				recovered = true
			} else {
				m.records[i].Status = "failed"
				m.records[i].Error = "ACP_SESSION_UNKNOWN"
			}
		}
		m.records[i].Execution = nil
	}
	if recovered {
		if err := m.save(); err != nil {
			return nil, errors.New("ACP session recovery could not be persisted")
		}
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
	records := make([]registryRecord, len(m.records))
	for i, record := range m.records {
		record.Execution = nil
		records[i] = registryRecord{Record: record, AgentSessionID: record.AgentSessionID, AgentTargetKey: record.AgentTargetKey, AgentAttempted: record.AgentAttempted}
	}
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
			r.Execution = nil
			if p := m.active[r.ID]; p != nil && p.ready && r.Status == "ready" && p.kind != "acp" {
				r.Execution = p.execution.snapshot()
			}
			records = append(records, r)
		}
	}
	agents := []string{"pi"}
	if m.cfg.ACP != nil {
		agents = append(agents, "codex-acp")
	}
	return map[string]any{"projects": projects, "sessions": records, "agents": agents, "acpAttach": m.cfg.ACP != nil && m.cfg.ACP.Socket != "" && runtime.GOOS == "windows", "maxActive": maxActive}
}

// Execute never waits for child readiness under the mutex. Status is explicit;
// Web waits for both the ready process AND its authoritative Relay snapshot.
func (m *Manager) Execute(q Request) (any, string) {
	targetID := ""
	if q.Operation == "threads" {
		if q.ID != "" || q.ProjectID != "" || q.Name != "" || q.Agent != "" || q.TargetKey != "" {
			return nil, "INVALID_REQUEST"
		}
		return m.listTargets(q.Room)
	}
	if q.TargetKey != "" {
		if q.Operation != "create" || q.Agent != "codex-acp" || !sessionID.MatchString(q.ID) || !targetKeyPattern.MatchString(q.TargetKey) {
			return nil, "INVALID_REQUEST"
		}
		m.mu.Lock()
		for _, existing := range m.records {
			if existing.ID == q.ID {
				m.mu.Unlock()
				if existing.Room == q.Room && existing.ProjectID == q.ProjectID && existing.Name == strings.TrimSpace(q.Name) && existing.Agent == "codex-acp" && existing.AgentMode == "attach" && existing.AgentTargetKey == q.TargetKey {
					return existing, ""
				}
				return nil, "REQUEST_CONFLICT"
			}
		}
		m.mu.Unlock()
		data, code := m.listTargets(q.Room)
		if code != "" {
			return nil, code
		}
		threads := data.(map[string]any)["threads"].([]AgentSession)
		for _, target := range threads {
			if target.Key == q.TargetKey && target.ProjectID == q.ProjectID {
				targetID = target.ID
				if target.Status != "idle" {
					return nil, "SESSION_BUSY"
				}
				break
			}
		}
		if targetID == "" {
			return nil, "SESSION_NOT_FOUND"
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return nil, "MANAGER_STOPPING"
	}
	if !identifier.MatchString(q.Room) {
		return nil, "INVALID_REQUEST"
	}
	if q.Operation == "list" {
		if q.ID != "" || q.ProjectID != "" || q.Name != "" || q.Agent != "" || q.TargetKey != "" {
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
		agent := q.Agent
		if agent == "" {
			agent = "pi"
		}
		if agent != "pi" && agent != "codex-acp" {
			return nil, "INVALID_REQUEST"
		}
		if agent == "pi" && q.TargetKey != "" {
			return nil, "INVALID_REQUEST"
		}
		if agent == "codex-acp" && m.cfg.ACP == nil {
			return nil, "AGENT_UNAVAILABLE"
		}
		mode := ""
		if agent == "codex-acp" {
			mode = "new"
			if q.TargetKey != "" {
				if !targetKeyPattern.MatchString(q.TargetKey) || targetID == "" {
					return nil, "INVALID_REQUEST"
				}
				if m.cfg.ACP.Socket == "" {
					return nil, "ACP_ATTACH_UNAVAILABLE"
				}
				mode = "attach"
			}
		}
		if mode == "attach" && runtime.GOOS != "windows" {
			return nil, "ACP_PLATFORM_UNSUPPORTED"
		}
		if !validName(q.Name) || m.project(q.ProjectID, q.Room) == nil {
			return nil, "PROJECT_UNAVAILABLE"
		}
		if index >= 0 {
			r := m.records[index]
			if r.Room != q.Room || r.ProjectID != q.ProjectID || r.Name != strings.TrimSpace(q.Name) || r.Agent != agent || r.AgentMode != mode || (mode == "attach" && (r.AgentSessionID != targetID || r.AgentTargetKey != q.TargetKey)) {
				return nil, "REQUEST_CONFLICT"
			}
			return r, ""
		}
		if mode == "attach" {
			for _, existing := range m.records {
				if existing.Agent == "codex-acp" && existing.AgentMode == "attach" && existing.AgentSessionID == targetID {
					return nil, "AGENT_TARGET_BUSY"
				}
			}
		}
		if len(m.records) >= maxSaved || len(m.active) >= maxActive {
			return nil, "MANAGED_LIMIT"
		}
		r := Record{ID: q.ID, ProjectID: q.ProjectID, Cwd: m.project(q.ProjectID, q.Room).Cwd, Room: q.Room, Name: strings.TrimSpace(q.Name), HostID: "managed-" + q.ID, Status: "stopped", Agent: agent, AgentMode: mode, AgentSessionID: targetID, AgentTargetKey: q.TargetKey}
		m.records = append(m.records, r)
		index = len(m.records) - 1
		// Persist the idempotency identity before any child can start. A lost HTTP
		// response or Relay restart cannot create a duplicate session for this ID.
		if err := m.save(); err != nil {
			m.records = m.records[:index]
			return nil, "REGISTRY_UNAVAILABLE"
		}
	} else if q.Operation == "open" || q.Operation == "close" {
		if q.ProjectID != "" || q.Name != "" || q.Agent != "" || q.TargetKey != "" {
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
	if r.Agent == "codex-acp" && r.AgentMode == "new" && r.AgentAttempted && r.AgentSessionID == "" {
		return nil, "ACP_SESSION_UNKNOWN"
	}
	if len(m.active) >= maxActive {
		return nil, "MANAGED_LIMIT"
	}
	if err := m.start(index, q.Operation == "create"); err != nil {
		r.Status = "failed"
		r.Error = "MANAGED_START_FAILED"
		switch err.Error() {
		case "ACP_SESSION_UNKNOWN", "ACP_PLATFORM_UNSUPPORTED", "ACP_ATTACH_UNAVAILABLE":
			r.Error = err.Error()
		}
		_ = m.save()
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
	if p.kind == "acp" {
		io.WriteString(p.stdin, "{\"type\":\"stop\"}\n")
	} else {
		io.WriteString(p.stdin, "{\"id\":\"managed-close\",\"type\":\"get_state\"}\n")
	}
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
	if r.Agent == "codex-acp" {
		return m.startACP(index, fresh)
	}
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
		if p.kind == "acp" {
			var event acpReadyEvent
			if json.Unmarshal(line, &event) == nil && event.Type == "cafe_space_ready" {
				m.markACPReady(p, id, event)
			}
			line = line[:0]
			continue
		}
		var event rpcEvent
		parseErr := json.Unmarshal(line, &event)
		line = line[:0]
		if parseErr != nil {
			continue
		}
		m.mu.Lock()
		if m.active[id] == p {
			p.execution.observe(event)
		}
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
		if r.ID != id {
			continue
		}
		if p.kind == "acp" && r.AgentMode == "new" && r.AgentSessionID == "" {
			if session := m.acpSessionID(id); session != "" {
				r.AgentSessionID = session
				if saveErr := m.save(); saveErr != nil {
					r.Error = "REGISTRY_UNAVAILABLE"
				}
			} else {
				r.Error = "ACP_SESSION_UNKNOWN"
			}
		}
		if r.Status != "failed" {
			if r.Status != "stopping" && (err != nil || !p.ready) {
				r.Status = "failed"
				r.Error = "MANAGED_PROCESS_EXITED"
			} else {
				r.Status = "stopped"
			}
		}
		if p.kind == "acp" && r.AgentMode == "new" && r.AgentSessionID == "" {
			r.Status = "failed"
			if r.Error == "" {
				r.Error = "ACP_SESSION_UNKNOWN"
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
	select {
	case <-m.closeDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (m *Manager) closeAll() {
	defer func() {
		if m.unlock != nil {
			m.unlock()
		}
	}()
	m.mu.Lock()
	m.closing = true
	for _, cancel := range m.queryCancels {
		cancel()
	}
	processes := []*process{}
	for id, p := range m.active {
		processes = append(processes, p)
		m.stop(p, id)
	}
	m.mu.Unlock()
	m.queries.Wait()
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
