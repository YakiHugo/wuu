package appserver

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// The fixture is the test executable, never an installed CLI or credential store.
func TestCodexLoginFixture(t *testing.T) {
	if os.Getenv("WUU_LOGIN_FIXTURE") != "1" {
		return
	}
	fmt.Print("\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\nEnter this one-time code\n\x1b[94mABCD-EFGHI\x1b[0m\nsecret-token-must-not-leak\n")
	switch os.Getenv("WUU_LOGIN_MODE") {
	case "fail":
		os.Exit(2)
	case "wait":
		time.Sleep(time.Hour)
	}
	os.Exit(0)
}
func loginFixture(t *testing.T, mode string) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestCodexLoginFixture$")
	cmd.Env = append(os.Environ(), "WUU_LOGIN_FIXTURE=1", "WUU_LOGIN_MODE="+mode)
	return cmd
}
func TestCodexLoginProcessContract(t *testing.T) {
	for _, mode := range []string{"success", "fail", "cancel", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			var hub codexLoginHub
			timeout := time.Minute
			fixtureMode := mode
			if mode == "cancel" || mode == "timeout" {
				fixtureMode = "wait"
			}
			if mode == "timeout" {
				timeout = 50 * time.Millisecond
			}
			start, err := hub.start(loginFixture(t, fixtureMode), timeout)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "cancel" {
				if _, err := hub.start(loginFixture(t, "success"), timeout); err == nil {
					t.Fatal("duplicate login admitted")
				}
				if err := hub.cancel(start.LoginID); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-hub.current.done:
			case <-time.After(5 * time.Second):
				t.Fatal("login did not finish")
			}
			got, err := hub.poll(start.LoginID)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"success": "success", "fail": "failed", "cancel": "cancelled", "timeout": "expired"}[mode]
			if got.Status != want {
				t.Fatalf("status = %q, want %q", got.Status, want)
			}
			if got.UserCode != "" || got.VerificationURI != "" {
				t.Fatal("terminal login retained its device prompt")
			}
			if strings.Contains(fmt.Sprint(got), "secret-token") {
				t.Fatal("raw output exposed")
			}
			if _, err := hub.poll("unknown"); err == nil {
				t.Fatal("unknown login accepted")
			}
		})
	}
}
func TestCodexLoginRejectsUntrustedPrompt(t *testing.T) {
	session := &codexLoginSession{}
	_, _ = session.Write([]byte("https://attacker.example/codex/device\nABCD-EFGHI\n"))
	if session.result.VerificationURI != "" || session.result.UserCode != "" {
		t.Fatal("untrusted prompt accepted")
	}
}

func TestCodexLoginShutdownAndRetry(t *testing.T) {
	var hub codexLoginHub
	if _, err := hub.start(exec.Command("/nonexistent/wuu-codex-fixture"), time.Minute); err == nil {
		t.Fatal("missing executable succeeded")
	}
	start, err := hub.start(loginFixture(t, "wait"), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	hub.close()
	got, err := hub.poll(start.LoginID)
	if err != nil || got.Status != "cancelled" {
		t.Fatalf("shutdown status: %#v, %v", got, err)
	}
	if _, err := hub.start(loginFixture(t, "success"), time.Minute); err == nil {
		t.Fatal("closed hub admitted login")
	}
}

func TestCodexLoginRestartReplacesOldAttempt(t *testing.T) {
	var hub codexLoginHub
	first, err := hub.start(loginFixture(t, "wait"), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err := hub.cancel(first.LoginID); err != nil {
		t.Fatal(err)
	}
	second, err := hub.start(loginFixture(t, "success"), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	<-hub.current.done
	if first.LoginID == second.LoginID {
		t.Fatal("login id reused")
	}
	if _, err := hub.poll(first.LoginID); err == nil {
		t.Fatal("stale login id accepted")
	}
}

func TestCodexLoginStreamsVerifiedPrompt(t *testing.T) {
	session := &codexLoginSession{}
	for _, chunk := range []string{"\x1b[94mhttps://auth.openai.com/codex/", "device\x1b[0m\nEnter this one-time code\n", "ABCD-EFGHI\n"} {
		_, _ = session.Write([]byte(chunk))
	}
	if session.result.VerificationURI != "https://auth.openai.com/codex/device" || session.result.UserCode != "ABCD-EFGHI" {
		t.Fatal("verified prompt was not streamed")
	}
}
