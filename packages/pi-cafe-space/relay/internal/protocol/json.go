// Package protocol implements the frozen JS wire semantics without Node or network I/O.
package protocol

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Object contains only JSON values: nil, bool, float64, string, []any or Object.
// Strings use UTF-8 with WTF-8 encodings for isolated UTF-16 surrogate units.
// Never hand these strings to encoding/json: it would silently replace those units.
// Use DecodeWire/EncodeWire at transport boundaries. Values must be treated as immutable.
type Object map[string]any

type parser struct {
	b []byte
	i int
}

func parseJSON(b []byte) (any, error) {
	if !utf8.Valid(b) {
		return nil, errors.New("Message is not valid UTF-8")
	}
	p := parser{b: b}
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.space()
	if p.i != len(b) {
		return nil, errors.New("trailing JSON content")
	}
	return v, nil
}
func stripBOM(b []byte) []byte { return bytes.TrimPrefix(b, []byte{0xef, 0xbb, 0xbf}) }
func (p *parser) space() {
	for p.i < len(p.b) {
		switch p.b[p.i] {
		case ' ', '\n', '\r', '\t':
			p.i++
		default:
			return
		}
	}
}
func (p *parser) take(c byte) bool {
	p.space()
	if p.i < len(p.b) && p.b[p.i] == c {
		p.i++
		return true
	}
	return false
}

// Iterative container parsing keeps stack bounded even for deeply nested unknown
// fields accepted by JSON.parse. Heap allocations remain bounded by input bytes.
func (p *parser) value() (any, error) {
	type frame struct {
		array            bool
		a                []any
		o                Object
		key              string
		first, needValue bool
	}
	stack := []frame{}
	var value any
	have := false
	for {
		if have {
			if len(stack) == 0 {
				return value, nil
			}
			f := &stack[len(stack)-1]
			if f.array {
				f.a = append(f.a, value)
			} else {
				f.o[f.key] = value
			}
			f.needValue = false
			f.first = false
			have = false
		}
		if len(stack) > 0 {
			f := &stack[len(stack)-1]
			end := byte('}')
			if f.array {
				end = ']'
			}
			if !f.needValue || f.first {
				if p.take(end) {
					if f.array {
						value = f.a
					} else {
						value = f.o
					}
					stack = stack[:len(stack)-1]
					have = true
					continue
				}
			}
			if !f.needValue {
				if !p.take(',') {
					return nil, errors.New("expected comma")
				}
				f.needValue = true
			}
			if !f.array {
				p.space()
				key, e := p.text()
				if e != nil {
					return nil, e
				}
				f.key = key
				if !p.take(':') {
					return nil, errors.New("expected colon")
				}
			}
			f.first = false
		}
		p.space()
		if p.i >= len(p.b) {
			return nil, errors.New("incomplete JSON")
		}
		var err error
		switch p.b[p.i] {
		case '{', '[':
			array := p.b[p.i] == '['
			p.i++
			stack = append(stack, frame{array: array, a: []any{}, o: Object{}, first: true, needValue: true})
			continue
		case '"':
			value, err = p.text()
		case 't':
			if !p.literal("true") {
				return nil, errors.New("invalid literal")
			}
			value = true
		case 'f':
			if !p.literal("false") {
				return nil, errors.New("invalid literal")
			}
			value = false
		case 'n':
			if !p.literal("null") {
				return nil, errors.New("invalid literal")
			}
			value = nil
		default:
			value, err = p.number()
		}
		if err != nil {
			return nil, err
		}
		have = true
	}
}
func (p *parser) literal(s string) bool {
	if bytes.HasPrefix(p.b[p.i:], []byte(s)) {
		p.i += len(s)
		return true
	}
	return false
}
func (p *parser) number() (any, error) {
	start := p.i
	if p.i < len(p.b) && p.b[p.i] == '-' {
		p.i++
	}
	if p.i >= len(p.b) {
		return nil, errors.New("invalid number")
	}
	if p.b[p.i] == '0' {
		p.i++
	} else {
		if p.b[p.i] < '1' || p.b[p.i] > '9' {
			return nil, errors.New("invalid number")
		}
		for p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
			p.i++
		}
	}
	if p.i < len(p.b) && p.b[p.i] == '.' {
		p.i++
		s := p.i
		for p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
			p.i++
		}
		if p.i == s {
			return nil, errors.New("invalid fraction")
		}
	}
	if p.i < len(p.b) && (p.b[p.i] == 'e' || p.b[p.i] == 'E') {
		p.i++
		if p.i < len(p.b) && (p.b[p.i] == '+' || p.b[p.i] == '-') {
			p.i++
		}
		s := p.i
		for p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
			p.i++
		}
		if p.i == s {
			return nil, errors.New("invalid exponent")
		}
	}
	n, e := strconv.ParseFloat(string(p.b[start:p.i]), 64)
	if e != nil && !errors.Is(e, strconv.ErrRange) {
		return nil, e
	}
	return n, nil // JSON.parse permits overflow in discarded unknown fields.
}
func (p *parser) hex() (uint16, error) {
	if p.i+4 > len(p.b) {
		return 0, errors.New("invalid unicode escape")
	}
	n, e := strconv.ParseUint(string(p.b[p.i:p.i+4]), 16, 16)
	p.i += 4
	return uint16(n), e
}
func (p *parser) text() (string, error) {
	if p.i >= len(p.b) || p.b[p.i] != '"' {
		return "", errors.New("expected string")
	}
	p.i++
	units := make([]uint16, 0)
	for p.i < len(p.b) {
		c := p.b[p.i]
		p.i++
		if c == '"' {
			return fromUnits(units), nil
		}
		if c < 0x20 {
			return "", errors.New("unescaped control")
		}
		if c == '\\' {
			if p.i >= len(p.b) {
				return "", errors.New("incomplete escape")
			}
			c = p.b[p.i]
			p.i++
			switch c {
			case '"', '\\', '/':
				units = append(units, uint16(c))
			case 'b':
				units = append(units, 8)
			case 'f':
				units = append(units, 12)
			case 'n':
				units = append(units, 10)
			case 'r':
				units = append(units, 13)
			case 't':
				units = append(units, 9)
			case 'u':
				u, e := p.hex()
				if e != nil {
					return "", e
				}
				units = append(units, u)
			default:
				return "", errors.New("invalid escape")
			}
			continue
		}
		if c < utf8.RuneSelf {
			units = append(units, uint16(c))
			continue
		}
		p.i--
		r, n := utf8.DecodeRune(p.b[p.i:])
		p.i += n
		if r > 0xffff {
			a, b := utf16.EncodeRune(r)
			units = append(units, uint16(a), uint16(b))
		} else {
			units = append(units, uint16(r))
		}
	}
	return "", errors.New("unterminated string")
}
func fromUnits(u []uint16) string {
	var b strings.Builder
	for i := 0; i < len(u); i++ {
		r := rune(u[i])
		if r >= 0xd800 && r <= 0xdbff && i+1 < len(u) && u[i+1] >= 0xdc00 && u[i+1] <= 0xdfff {
			b.WriteRune(utf16.DecodeRune(r, rune(u[i+1])))
			i++
		} else if r >= 0xd800 && r <= 0xdfff {
			b.WriteByte(byte(0xe0 | (r >> 12)))
			b.WriteByte(byte(0x80 | ((r >> 6) & 63)))
			b.WriteByte(byte(0x80 | (r & 63)))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}
func codeUnits(s string) []uint16 {
	u := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		if i+2 < len(s) && s[i] == 0xed && s[i+1] >= 0xa0 && s[i+1] <= 0xbf && s[i+2] >= 0x80 && s[i+2] <= 0xbf {
			u = append(u, uint16(s[i]&15)<<12|uint16(s[i+1]&63)<<6|uint16(s[i+2]&63))
			i += 3
			continue
		}
		r, n := utf8.DecodeRuneInString(s[i:])
		i += n
		if r > 0xffff {
			a, b := utf16.EncodeRune(r)
			u = append(u, uint16(a), uint16(b))
		} else {
			u = append(u, uint16(r))
		}
	}
	return u
}
func stringLen(s string) int { return len(codeUnits(s)) }
func prefix(s string, max int) string {
	u := codeUnits(s)
	if len(u) <= max {
		return fromUnits(u)
	}
	if max < 0 {
		max = 0
	}
	if max > 0 && u[max-1] >= 0xd800 && u[max-1] <= 0xdbff {
		max--
	}
	return fromUnits(u[:max])
}
func quote(b *strings.Builder, s string) {
	b.WriteByte('"')
	u := codeUnits(s)
	for i := 0; i < len(u); i++ {
		c := u[i]
		switch c {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteByte(byte(c))
		case 8:
			b.WriteString(`\b`)
		case 9:
			b.WriteString(`\t`)
		case 10:
			b.WriteString(`\n`)
		case 12:
			b.WriteString(`\f`)
		case 13:
			b.WriteString(`\r`)
		default:
			if c < 32 {
				fmt.Fprintf(b, `\u%04x`, c)
			} else if c >= 0xd800 && c <= 0xdbff && i+1 < len(u) && u[i+1] >= 0xdc00 && u[i+1] <= 0xdfff {
				b.WriteRune(utf16.DecodeRune(rune(c), rune(u[i+1])))
				i++
			} else if c >= 0xd800 && c <= 0xdfff {
				fmt.Fprintf(b, `\u%04x`, c)
			} else {
				b.WriteRune(rune(c))
			}
		}
	}
	b.WriteByte('"')
}
func stringify(v any) ([]byte, error) {
	var b strings.Builder
	err := writeJSON(&b, v, 0)
	if err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}
func writeJSON(b *strings.Builder, v any, depth int) error {
	if depth > 10000 {
		return errors.New("JSON nesting too deep")
	}
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		quote(b, x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return errors.New("nonfinite number")
		}
		if x == 0 {
			b.WriteByte('0')
			break
		}
		format := byte('g')
		if math.Abs(x) >= 1e-6 && math.Abs(x) < 1e21 {
			format = 'f'
		}
		s := strconv.FormatFloat(x, format, -1, 64)
		s = strings.ReplaceAll(s, "e-0", "e-")
		s = strings.ReplaceAll(s, "e+0", "e+")
		b.WriteString(s)
	case []any:
		b.WriteByte('[')
		for i, v := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeJSON(b, v, depth+1); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case Object:
		b.WriteByte('{')
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			quote(b, k)
			b.WriteByte(':')
			if err := writeJSON(b, x[k], depth+1); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("non-JSON value %T", v)
	}
	return nil
}
