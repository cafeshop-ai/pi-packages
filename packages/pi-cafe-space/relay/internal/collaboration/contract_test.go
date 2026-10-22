package collaboration

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func contractFrom(t *testing.T, s *Store) map[string]any {
	t.Helper()
	r := httptest.NewRequest("GET", endpoint+"/guide", nil)
	r.Header.Set("Accept", "application/json")
	w := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") || w.Header().Get("Vary") != "Accept" {
		t.Fatalf("contract response: %d %v", w.Code, w.Header())
	}
	var doc map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil || doc["openapi"] != "3.1.0" {
		t.Fatalf("contract is not OpenAPI 3.1 JSON: %v", err)
	}
	return doc
}

func TestContractMatchesTheImplementation(t *testing.T) {
	s := store(t)
	doc := contractFrom(t, s)
	text := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(text, httptest.NewRequest("GET", endpoint+"/guide", nil))
	if !strings.HasPrefix(text.Header().Get("Content-Type"), "text/plain") || text.Header().Get("Vary") != "Accept" {
		t.Fatal("the text guide stays the default")
	}
	schemas := doc["components"].(map[string]any)["schemas"].(map[string]any)
	properties := map[string]bool{}
	ops := []string{}
	for name, raw := range schemas {
		if name == "error" {
			continue
		}
		ops = append(ops, name)
		for property := range raw.(map[string]any)["properties"].(map[string]any) {
			properties[property] = true
		}
	}
	// Every request field the server accepts is documented.
	fields := reflect.TypeOf(request{})
	for i := 0; i < fields.NumField(); i++ {
		tag := strings.Split(fields.Field(i).Tag.Get("json"), ",")[0]
		if !properties[tag] {
			t.Errorf("request field %q missing from the contract", tag)
		}
	}
	// Every documented op is one the server dispatches.
	id, owner := create(t, s)
	if _, body := post(s, map[string]any{"op": "bogus", "roomId": id}, owner); body["error"] != "INVALID_OPERATION" {
		t.Fatal("unknown ops must be rejected")
	}
	sort.Slice(ops, func(i, j int) bool { return ops[j] == "close" || ops[i] < ops[j] && ops[i] != "close" }) // close last: it ends the room
	for _, name := range ops {
		code, body := post(s, map[string]any{"op": name, "roomId": id}, owner)
		if body["error"] == "INVALID_OPERATION" {
			t.Errorf("contract op %q is not implemented (%d)", name, code)
		}
	}
	// Every error code the package can return is listed with its status.
	source, err := os.ReadFile("rooms.go")
	if err != nil {
		t.Fatal(err)
	}
	statuses := doc["x-error-status"].(map[string]any)
	for _, match := range regexp.MustCompile(`fail\((\d+), "([A-Z_]+)"\)`).FindAllStringSubmatch(string(source), -1) {
		want, _ := strconv.Atoi(match[1])
		if got, ok := statuses[match[2]]; !ok || int(got.(float64)) != want {
			t.Errorf("error %s (%d) missing or wrong in the contract: %v", match[2], want, got)
		}
	}
	if features := doc["x-features"].([]any); len(features) != len(call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any)) {
		t.Fatal("contract features must match status")
	}
}
