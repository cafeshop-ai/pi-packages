package managed

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

const maxTargetOutput = 256 * 1024
const targetCacheDuration = 5 * time.Second

type acpReadyEvent struct {
	Type           string `json:"type"`
	Mode           string `json:"mode"`
	HostID         string `json:"hostId"`
	SessionID      string `json:"sessionId"`
	AgentSessionID string `json:"agentSessionId"`
}

var targetKeyPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func newTargetKey() (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func validACPSocketPath(path string) bool {
	return path == "" || filepath.IsAbs(path) && len(path) <= 4096 && !strings.ContainsFunc(path, func(char rune) bool { return char < 32 || char == 127 })
}

func validateACPRuntime(root string) error {
	for _, pkg := range []struct{ path, version string }{
		{filepath.Join(root, "node_modules", "@agentclientprotocol", "sdk", "package.json"), "2.1.0"},
		{filepath.Join(root, "node_modules", "@agentclientprotocol", "codex-acp", "package.json"), "2.5.0"},
	} {
		path, err := canonical(pkg.path, false)
		if err != nil {
			return errors.New("ACP runtime dependencies are unavailable")
		}
		info, err := os.Stat(path)
		if err != nil || info.Size() > 64*1024 {
			return errors.New("invalid ACP runtime manifest")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return errors.New("invalid ACP runtime manifest")
		}
		var manifest struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(data, &manifest) != nil || manifest.Version != pkg.version {
			return errors.New("unsupported ACP runtime dependency version")
		}
	}
	return nil
}

type targetCache struct {
	threads   []AgentSession
	truncated bool
	failed    bool
	at        time.Time
}

func validateEnvironment(env map[string]string) error {
	if len(env) > 64 {
		return errors.New("managed environment limit exceeded")
	}
	seen := make(map[string]bool, len(env))
	for key, value := range env {
		upper := strings.ToUpper(key)
		reserved := strings.HasPrefix(upper, "PI_COLLAB_") || strings.HasPrefix(upper, "PI_CAFE_") || strings.HasPrefix(upper, "CAFE_SHARED_") || strings.HasPrefix(upper, "CAFE_ACP_")
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) || reserved || seen[upper] || upper == "PI_CODING_AGENT_DIR" || upper == "PI_OFFLINE" || upper == "PI_TELEMETRY" || upper == "NODE_OPTIONS" || upper == "NODE_PATH" || len(key) > 256 || len(value) > 32768 {
			return errors.New("invalid managed environment")
		}
		seen[upper] = true
	}
	return nil
}

func (m *Manager) childEnv(extra map[string]string) []string {
	values := make(map[string]string, len(os.Environ())+len(extra))
	allowed := map[string]bool{"PATH": true, "HOME": true, "TMPDIR": true, "LANG": true, "LC_ALL": true}
	if runtime.GOOS == "windows" {
		for _, key := range []string{"SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "COMSPEC"} {
			allowed[key] = true
		}
	}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || !allowed[strings.ToUpper(key)] {
			continue
		}
		values[strings.ToUpper(key)] = value
	}
	for key, value := range extra {
		values[strings.ToUpper(key)] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+values[key])
	}
	return out
}

func refreshTargetKeys(threads, previous []AgentSession) error {
	for i := range threads {
		threads[i].Key = ""
		for _, old := range previous {
			if threads[i].ID == old.ID && threads[i].ProjectID == old.ProjectID && targetKeyPattern.MatchString(old.Key) {
				threads[i].Key = old.Key
				break
			}
		}
		if threads[i].Key == "" {
			key, err := newTargetKey()
			if err != nil {
				return err
			}
			threads[i].Key = key
		}
	}
	return nil
}

func (m *Manager) listTargets(room string) (any, string) {
	if !identifier.MatchString(room) {
		return nil, "INVALID_REQUEST"
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return nil, "MANAGER_STOPPING"
	}
	if m.cfg.ACP == nil {
		m.mu.Unlock()
		return nil, "AGENT_UNAVAILABLE"
	}
	if m.cfg.ACP.Socket == "" {
		m.mu.Unlock()
		return nil, "ACP_ATTACH_UNAVAILABLE"
	}
	if runtime.GOOS != "windows" {
		m.mu.Unlock()
		return nil, "ACP_PLATFORM_UNSUPPORTED"
	}
	projects := make([]Project, 0, len(m.cfg.Projects))
	for _, project := range m.cfg.Projects {
		if project.Room == room {
			projects = append(projects, project)
		}
	}
	config := *m.cfg.ACP
	m.mu.Unlock()
	if len(projects) == 0 {
		return map[string]any{"threads": []AgentSession{}, "truncated": false}, ""
	}

	m.targetsMu.Lock()
	defer m.targetsMu.Unlock()
	previous, hadPrevious := m.targets[room]
	if cached, ok := m.targets[room]; ok && time.Since(cached.at) < targetCacheDuration {
		if cached.failed {
			return nil, "ACP_LIST_UNAVAILABLE"
		}
		return map[string]any{"threads": append([]AgentSession(nil), cached.threads...), "truncated": cached.truncated}, ""
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return nil, "MANAGER_STOPPING"
	}
	m.queryNext++
	queryID := m.queryNext
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	m.queryCancels[queryID] = cancel
	m.queries.Add(1)
	m.mu.Unlock()
	defer func() { cancel(); m.mu.Lock(); delete(m.queryCancels, queryID); m.mu.Unlock(); m.queries.Done() }()
	threads, truncated, err := m.queryTargets(ctx, config, projects, room)
	if err != nil {
		m.targets[room] = targetCache{failed: true, at: time.Now()}
		return nil, "ACP_LIST_UNAVAILABLE"
	}
	var oldThreads []AgentSession
	if hadPrevious {
		oldThreads = previous.threads
	}
	if err := refreshTargetKeys(threads, oldThreads); err != nil {
		return nil, "ACP_LIST_UNAVAILABLE"
	}
	m.mu.Lock()
	closing := m.closing
	m.mu.Unlock()
	if closing {
		return nil, "MANAGER_STOPPING"
	}
	m.targets[room] = targetCache{threads: threads, truncated: truncated, at: time.Now()}
	return map[string]any{"threads": threads, "truncated": truncated}, ""
}

func (m *Manager) queryTargets(ctx context.Context, config ACPConfig, projects []Project, room string) ([]AgentSession, bool, error) {
	directory := filepath.Join(m.cfg.StateDir, "acp-targets")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, false, err
	}
	real, err := canonical(directory, true)
	if err != nil || real != directory {
		return nil, false, errors.New("invalid ACP query directory")
	}
	projectValues := make([]map[string]string, 0, len(projects))
	for _, project := range projects {
		projectValues = append(projectValues, map[string]string{"id": project.ID, "cwd": project.Cwd})
	}
	data, err := json.Marshal(map[string]any{"codex": config.Codex, "socket": config.Socket, "projects": projectValues})
	if err != nil {
		return nil, false, err
	}
	file, err := os.CreateTemp(directory, "targets-*.json")
	if err != nil {
		return nil, false, err
	}
	path := file.Name()
	defer os.Remove(path)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, false, err
	}

	cmd := exec.Command(m.cfg.Node, m.targetsRunner, "--config", path)
	cmd.Dir, cmd.Env, cmd.Stderr = projects[0].Cwd, m.childEnv(config.Env), io.Discard
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	release, err := startOwnedProcess(cmd)
	if err != nil {
		return nil, false, err
	}
	type output struct {
		data    []byte
		readErr error
	}
	readDone := make(chan output, 1)
	go func() {
		data, readErr := io.ReadAll(io.LimitReader(stdout, maxTargetOutput+1))
		readDone <- output{data, readErr}
	}()
	var result output
	select {
	case result = <-readDone:
		if len(result.data) > maxTargetOutput {
			release()
			_ = cmd.Wait()
			return nil, false, errors.New("ACP target output exceeded limit")
		}
	case <-ctx.Done():
		release()
		result = <-readDone
		_ = cmd.Wait()
		return nil, false, errors.New("ACP target query timed out")
	}
	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()
	var waitErr error
	select {
	case waitErr = <-waitDone:
	case <-ctx.Done():
		release()
		waitErr = <-waitDone
		return nil, false, errors.New("ACP target query timed out")
	}
	release()
	if result.readErr != nil || waitErr != nil {
		return nil, false, errors.New("ACP target query failed")
	}
	return m.parseTargetOutput(result.data, room)
}

func (m *Manager) parseTargetOutput(data []byte, room string) ([]AgentSession, bool, error) {
	if len(data) > maxTargetOutput {
		return nil, false, errors.New("invalid ACP target response")
	}
	var reply struct {
		Type    string `json:"type"`
		Threads []struct {
			ID        string `json:"id"`
			ProjectID string `json:"projectId"`
			Name      string `json:"name"`
			Cwd       string `json:"cwd"`
			Status    string `json:"status"`
		} `json:"threads"`
		Truncated *bool `json:"truncated"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&reply) != nil || decoder.Decode(new(any)) != io.EOF || reply.Type != "cafe_space_targets" || reply.Truncated == nil || len(reply.Threads) > 100 {
		return nil, false, errors.New("invalid ACP target response")
	}
	threads := make([]AgentSession, 0, len(reply.Threads))
	seen := map[string]bool{}
	for _, thread := range reply.Threads {
		project := m.project(thread.ProjectID, room)
		if !agentSessionID.MatchString(thread.ID) || project == nil || thread.Cwd != project.Cwd || !validName(thread.Name) || !map[string]bool{"idle": true, "active": true, "systemError": true, "unknown": true}[thread.Status] || seen[thread.ID] {
			return nil, false, errors.New("invalid ACP target")
		}
		seen[thread.ID] = true
		threads = append(threads, AgentSession{ID: thread.ID, ProjectID: project.ID, Name: thread.Name, Cwd: project.Cwd, Status: thread.Status})
	}
	return threads, *reply.Truncated, nil
}

func agentStateDirectory(stateDir, id string) string {
	return filepath.Join(stateDir, "sessions", "acp", id)
}
func readACPState(directory string) (string, error) {
	path := filepath.Join(directory, "agent-session.json")
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 1024 {
		return "", errors.New("invalid ACP session state")
	}
	var state struct {
		SessionID string `json:"sessionId"`
	}
	if err := readJSON(path, &state); err != nil || !agentSessionID.MatchString(state.SessionID) {
		return "", errors.New("invalid ACP session state")
	}
	return state.SessionID, nil
}

func (m *Manager) startACP(index int, fresh bool) error {
	r := &m.records[index]
	if r.AgentMode == "attach" && runtime.GOOS != "windows" {
		return errors.New("ACP_PLATFORM_UNSUPPORTED")
	}
	if m.cfg.ACP == nil || m.acpRunner == "" {
		return errors.New("ACP runtime unavailable")
	}
	project := m.project(r.ProjectID, r.Room)
	if project == nil {
		return errors.New("project unavailable")
	}
	cwd, err := canonical(project.Cwd, true)
	if err != nil || cwd != project.Cwd {
		return errors.New("project changed")
	}
	stateDirectory := agentStateDirectory(m.cfg.StateDir, r.ID)
	if err = os.MkdirAll(stateDirectory, 0700); err != nil {
		return err
	}
	real, err := canonical(stateDirectory, true)
	if err != nil || real != stateDirectory {
		return errors.New("ACP state directory changed")
	}
	mode := "new"
	config := map[string]any{
		"mode": mode, "relayUrl": m.relayURL, "roomId": r.Room, "hostId": r.HostID,
		"token": m.hostToken, "acpRoot": m.cfg.ACP.Root, "codex": m.cfg.ACP.Codex, "managedSessionId": r.ID,
		"cwd": r.Cwd, "name": r.Title, "stateDirectory": stateDirectory, "promptBudget": nil, "managed": true,
	}
	if r.Title == "" {
		config["name"] = r.Name
	}
	if r.AgentMode == "attach" {
		if m.cfg.ACP.Socket == "" {
			return errors.New("ACP attach unavailable")
		}
		mode = "attach"
		config["mode"] = mode
		delete(config, "cwd")
		config["socket"], config["threadId"], config["expectedCwd"] = m.cfg.ACP.Socket, r.AgentSessionID, r.Cwd
	} else if r.AgentSessionID != "" {
		mode = "restore"
		config["mode"], config["threadId"] = mode, r.AgentSessionID
	} else if r.AgentAttempted {
		return errors.New("ACP_SESSION_UNKNOWN")
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return err
	}
	cmd := exec.Command(m.cfg.Node, m.acpRunner, "--config-env")
	cmd.Dir, cmd.Env, cmd.Stderr = cwd, append(m.childEnv(m.cfg.ACP.Env), "CAFE_ACP_CONFIG_JSON="+string(encoded)), io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return err
	}
	if mode == "new" && !r.AgentAttempted {
		r.AgentAttempted = true
		if err = m.save(); err != nil {
			r.AgentAttempted = false
			stdin.Close()
			return err
		}
	}
	release, err := startOwnedProcess(cmd)
	if err != nil {
		stdin.Close()
		stdout.Close()
		return err
	}
	stdin = newBoundedInput(stdin, release)
	p := &process{cmd: cmd, stdin: stdin, done: make(chan struct{}), release: release, kind: "acp", agentMode: mode}
	m.active[r.ID] = p
	r.Status, r.Error = "starting", ""
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
	return nil
}

func (m *Manager) markACPReady(p *process, id string, event acpReadyEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active[id] != p {
		return
	}
	for i := range m.records {
		r := &m.records[i]
		if r.ID != id {
			continue
		}
		if event.Type != "cafe_space_ready" || event.HostID != r.HostID || event.Mode != p.agentMode || event.SessionID != r.ID || !agentSessionID.MatchString(event.AgentSessionID) || (r.AgentSessionID != "" && r.AgentSessionID != event.AgentSessionID) {
			m.fail(id, "MANAGED_START_FAILED")
			p.stdin.Close()
			return
		}
		previous := r.AgentSessionID
		r.AgentSessionID = event.AgentSessionID
		if err := m.save(); err != nil {
			r.AgentSessionID = previous
			m.fail(id, "REGISTRY_UNAVAILABLE")
			p.stdin.Close()
			return
		}
		p.ready = true
		r.Status, r.Error = "ready", ""
		return
	}
}

func (m *Manager) acpSessionID(id string) string {
	state, err := readACPState(agentStateDirectory(m.cfg.StateDir, id))
	if err != nil {
		return ""
	}
	return state
}
