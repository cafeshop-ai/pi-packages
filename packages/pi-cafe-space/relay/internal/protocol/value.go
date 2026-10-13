package protocol

// ValueBytes serializes already validated internal JSON values with the same
// binary64/WTF-8 rules as EncodeWire, without a wire schema or frame-size test.
// Used for accounting before trimming and hashing non-wire projection fields.
// Untrusted ingress must still pass DecodeWire; outbound must use EncodeWire.
func ValueBytes(value any) ([]byte, error) { return stringify(value) }
func UTF16Length(s string) int             { return stringLen(s) }
func UTF16Prefix(s string, n int) string   { return prefix(s, n) }

// UTF16Less matches JavaScript lexical ordering, including supplementary and
// isolated-surrogate IDs; UTF-8 byte order is not the same ordering.
func UTF16Less(a, b string) bool {
	aa, bb := codeUnits(a), codeUnits(b)
	for i := 0; i < len(aa) && i < len(bb); i++ {
		if aa[i] != bb[i] {
			return aa[i] < bb[i]
		}
	}
	return len(aa) < len(bb)
}
