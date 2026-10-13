package hub

import (
	"encoding/json"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestPartsProjectionBudget(t *testing.T) {
	b, err := os.ReadFile("../../../protocol/fixtures/parts/ordered.json")
	if err != nil {
		t.Fatal(err)
	}
	// The fixture's final snapshot is obtained through its typed events, not Go JSON.
	// Extract raw expectedFinal without decoding any protocol strings/numbers via encoding/json.
	var fixture struct {
		ExpectedFinal json.RawMessage `json:"expectedFinal"`
	}
	if err := json.Unmarshal(b, &fixture); err != nil {
		t.Fatal(err)
	}
	input := append([]byte(`{"type":"snapshot","snapshot":`), fixture.ExpectedFinal...)
	input = append(input, '}')
	wire, err := protocol.DecodeWire(input)
	if err != nil {
		t.Fatal(err)
	}
	s := wire["snapshot"].(object)
	if !reflect.DeepEqual(compactSnapshot(s), s) {
		t.Fatal("dropped in-budget fields")
	}
	m := copyObject(s["messages"].([]any)[0].(object))
	parts := []any{}
	for i := 0; i < 12; i++ {
		parts = append(parts, object{"index": float64(i), "type": "text", "text": strings.Repeat("😀", 32000)})
	}
	m["parts"] = parts
	huge := copyObject(s)
	huge["messages"] = []any{m}
	result := compactSnapshot(huge)
	messages := result["messages"].([]any)
	if len(messages) != 1 {
		t.Fatal("lost message rather than dropping oversized parts")
	}
	message := messages[0].(object)
	if _, present := message["parts"]; present || message["partsTruncated"] != true || result["historyTruncated"] != true {
		t.Fatal("missing incomplete markers")
	}
	encoded, err := protocol.EncodeWire(object{"type": "snapshot", "snapshot": result})
	if err != nil || len(encoded) > snapshotBudget {
		t.Fatal("over budget", err)
	}
	if len(m["parts"].([]any)) != 12 {
		t.Fatal("mutated input")
	}
}
