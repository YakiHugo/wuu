package appserver

import (
	"context"
	"crypto/rand"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/blueberrycongee/wuu/internal/enginecatalog"
	"github.com/blueberrycongee/wuu/internal/process"
)

const codexLoginTimeout = 15 * time.Minute

// The CLI owns OAuth, token exchange and storage. Only its public device prompt
// crosses the protocol boundary; raw subprocess output can contain credentials.
type codexLoginSession struct {
	mu          sync.Mutex
	result      AuthCodexLoginResult
	line        string
	discardLine bool
	expectCode  bool
	done        chan struct{}
	cancelCh    chan struct{}
	cancelOnce  sync.Once
}

var codexANSI = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
var codexDeviceCode = regexp.MustCompile(`^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$`)

func (session *codexLoginSession) Write(p []byte) (int, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	for _, b := range p {
		if b == '\n' {
			if !session.discardLine {
				line := strings.TrimSpace(codexANSI.ReplaceAllString(session.line, ""))
				if line == "https://auth.openai.com/codex/device" {
					session.result.VerificationURI = line
				}
				if strings.Contains(line, "Enter this one-time code") && session.result.VerificationURI != "" {
					session.expectCode = true
				} else if session.expectCode && codexDeviceCode.MatchString(line) {
					session.result.UserCode = line
					session.expectCode = false
				}
			}
			session.line = ""
			session.discardLine = false
		} else if !session.discardLine {
			if len(session.line) >= 4096 {
				session.line = ""
				session.discardLine = true
			} else {
				session.line += string(b)
			}
		}
	}
	return len(p), nil
}

type codexLoginHub struct {
	mu      sync.Mutex
	current *codexLoginSession
	closed  bool
}

func (hub *codexLoginHub) start(cmd *exec.Cmd, timeout time.Duration) (AuthCodexLoginResult, error) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return AuthCodexLoginResult{}, errServerClosed
	}
	if hub.current != nil {
		select {
		case <-hub.current.done:
		default:
			return AuthCodexLoginResult{}, errors.New("a ChatGPT login is already running; finish or cancel it first")
		}
	}
	session := &codexLoginSession{
		result: AuthCodexLoginResult{LoginID: rand.Text(), Status: "pending", IntervalMS: 1000, ExpiresInSeconds: int(timeout.Seconds())},
		done:   make(chan struct{}), cancelCh: make(chan struct{}),
	}
	cmd.Stdout = session
	cmd.Stderr = session
	cmd.WaitDelay = 2 * time.Second
	handle, err := process.StartCommand(cmd)
	if err != nil {
		return AuthCodexLoginResult{}, errors.New("could not start Codex CLI; check its configured executable")
	}
	hub.current = session
	go func() {
		defer close(session.done)
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		status := ""
		select {
		case <-handle.Done():
		case <-session.cancelCh:
			status = "cancelled"
			_ = handle.Stop(time.Second)
		case <-timer.C:
			status = "expired"
			_ = handle.Stop(time.Second)
		}
		err := handle.Wait()
		session.mu.Lock()
		defer session.mu.Unlock()
		session.result.UserCode = ""
		session.result.VerificationURI = ""
		session.line = ""
		if status != "" {
			session.result.Status = status
		} else if err != nil {
			session.result.Status = "failed"
			session.result.Error = "Codex sign-in failed. Check your network and device code login in ChatGPT security settings; update Codex CLI if needed, then retry."
		} else {
			session.result.Status = "success"
		}
	}()
	session.mu.Lock()
	defer session.mu.Unlock()
	result := session.result
	result.Status = "pending" // Clients always observe completion through poll.
	return result, nil
}

func (hub *codexLoginHub) poll(id string) (AuthCodexLoginResult, error) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if id == "" || hub.current == nil || hub.current.result.LoginID != id {
		return AuthCodexLoginResult{}, errors.New("ChatGPT login was not found; start again")
	}
	hub.current.mu.Lock()
	defer hub.current.mu.Unlock()
	return hub.current.result, nil
}
func (hub *codexLoginHub) cancel(id string) error {
	hub.mu.Lock()
	session := hub.current
	if id == "" || session == nil || session.result.LoginID != id {
		hub.mu.Unlock()
		return errors.New("ChatGPT login was not found")
	}
	session.cancelOnce.Do(func() { close(session.cancelCh) })
	hub.mu.Unlock()
	<-session.done
	return nil
}
func (hub *codexLoginHub) close() {
	hub.mu.Lock()
	hub.closed = true
	session := hub.current
	if session != nil {
		session.cancelOnce.Do(func() { close(session.cancelCh) })
	}
	hub.mu.Unlock()
	if session != nil {
		<-session.done
	}
}

func (s *Server) handleAuthCodexLoginStart(_ context.Context, req Request) error {
	if s.rt == nil {
		return s.writeResponse(req.ID, nil, errors.New("runtime is not initialized"))
	}
	entry, _ := enginecatalog.Lookup("codex")
	override := ""
	if settings := s.engineSettingsFromConfig().Binary("codex"); settings != nil {
		override = settings.BinaryPath
	}
	binary, err := entry.Resolve(override)
	if err != nil {
		return s.writeResponse(req.ID, nil, errors.New("Codex CLI was not found. Install it from https://developers.openai.com/codex/cli/ or configure its executable path"))
	}
	// No shell, renderer-supplied executable, arguments or environment overrides.
	result, err := s.codexLogins.start(exec.Command(binary, "login", "--device-auth"), codexLoginTimeout)
	return s.writeResponse(req.ID, result, err)
}
func (s *Server) handleAuthCodexLoginPoll(req Request) error {
	var params AuthCodexLoginParams
	if err := decodeParams(req.Params, &params); err != nil {
		return s.writeResponse(req.ID, nil, err)
	}
	result, err := s.codexLogins.poll(strings.TrimSpace(params.LoginID))
	return s.writeResponse(req.ID, result, err)
}
func (s *Server) handleAuthCodexLoginCancel(req Request) error {
	var params AuthCodexLoginParams
	if err := decodeParams(req.Params, &params); err != nil {
		return s.writeResponse(req.ID, nil, err)
	}
	err := s.codexLogins.cancel(strings.TrimSpace(params.LoginID))
	return s.writeResponse(req.ID, map[string]bool{"ok": err == nil}, err)
}
