package config

import (
 "strings"
 "testing"
)

func TestLocalCustomTokenHasNoComplexityRequirement(t *testing.T) {
 for _, token := range []string{"abcdef", "123456", "aaaaaa", "café12", "我的访问令牌", "two words", strings.Repeat("a", 20)} {
  if !ValidSetupToken(token) { t.Fatalf("local user token rejected: %q", token) }
 }
 for _, token := range []string{"", " ", "a", "12345", " padded", "padded ", "line\nbreak", "a\x00b", "a\u0085b", strings.Repeat("a", 21)} {
  if ValidSetupToken(token) { t.Fatal("invalid single-line/bounded input accepted") }
 }
 if !ValidStoredSetupToken(strings.Repeat("a", 64)) || ValidSetupToken(strings.Repeat("a", 64)) { t.Fatal("legacy compatibility must not widen new setup bounds") }
 for _, token := range []string{"123", "aaaa", "local-dev-host-token"} {
  if ValidSetupHostToken(token) { t.Fatal("user token was treated as a generated internal host key") }
 }
}
