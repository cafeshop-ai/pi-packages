package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"golang.org/x/net/idna"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf16"
)

type Origins struct{ allowed map[string]struct{} }

var browserIDNA = idna.New(idna.MapForLookup(), idna.StrictDomainName(false), idna.CheckHyphens(false), idna.VerifyDNSLength(false), idna.BidiRule())

func TokenMatches(actual, expected string) bool {
	a := sha256.Sum256([]byte(actual))
	b := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
func NewOrigins(values []string) (Origins, error) {
	out := Origins{allowed: map[string]struct{}{}}
	if len(values) > 64 {
		return out, errors.New("too many origins")
	}
	for _, v := range values {
		o, e := NormalizeOrigin(v)
		if e != nil {
			return out, e
		}
		out.allowed[o] = struct{}{}
	}
	return out, nil
}
func (o Origins) Allowed(r *http.Request) bool {
	values := r.Header.Values("Origin")
	if len(values) == 0 {
		return true
	}
	if len(values) != 1 {
		return false
	}
	// Node treats an empty Origin header like absence.
	if values[0] == "" {
		return true
	}
	origin, e := NormalizeOrigin(values[0])
	if e != nil {
		return false
	}
	if _, ok := o.allowed[origin]; ok {
		return true
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	own, e := NormalizeOrigin(scheme + "://" + r.Host)
	return e == nil && own == origin
}
func NormalizeOrigin(raw string) (string, error) {
	bad := func() (string, error) { return "", errors.New("invalid http(s) origin") }
	s := strings.Trim(raw, " \t\r\n\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	if len(utf16.Encode([]rune(s))) > 2048 || strings.ContainsAny(s, "?#") {
		return bad()
	}
	// WHATWG special-scheme URL handling used by the TS baseline.
	s = strings.NewReplacer("\t", "", "\r", "", "\n", "", "\\", "/").Replace(s)
	colon := strings.IndexByte(s, ':')
	if colon < 0 {
		return bad()
	}
	scheme := strings.ToLower(s[:colon])
	if scheme != "http" && scheme != "https" {
		return bad()
	}
	rest := strings.TrimLeft(s[colon+1:], "/")
	authority, suffix, hasPath := strings.Cut(rest, "/")
	if strings.Contains(authority, "%") && !strings.HasPrefix(authority, "[") {
		hostPart, portPart, hasPort := strings.Cut(authority, ":")
		decoded, err := url.PathUnescape(hostPart)
		if err != nil || strings.ContainsAny(decoded, " /\\#?@:%[]\x00") {
			return bad()
		}
		authority = decoded
		if hasPort {
			authority += ":" + portPart
		}
	}
	s = scheme + "://" + authority
	if hasPath {
		s += "/" + suffix
	}
	u, e := url.Parse(s)
	if e != nil || u.User != nil || u.Hostname() == "" || !rootOriginPath(u.EscapedPath()) {
		return bad()
	}
	host := u.Hostname()
	if strings.Contains(host, ":") {
		ip := net.ParseIP(host)
		if ip == nil {
			return bad()
		}
		host = "[" + ipv6Text(ip) + "]"
	} else {
		host, e = browserIDNA.ToASCII(strings.ToLower(host))
		if e != nil || strings.ContainsAny(host, " /\\#?@:%[]\x00") {
			return bad()
		}
		if ip, numeric, valid := normalizeIPv4(host); numeric {
			if !valid {
				return bad()
			}
			host = ip
		}
	}
	port := u.Port()
	if port != "" {
		n, e := strconv.ParseUint(port, 10, 16)
		if e != nil {
			return bad()
		}
		port = strconv.FormatUint(n, 10)
		if (scheme == "http" && n == 80) || (scheme == "https" && n == 443) {
			port = ""
		}
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host, nil
}
func rootOriginPath(p string) bool {
	if p == "" || p == "/" {
		return true
	}
	stack := []string{}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	for i, part := range parts {
		dot := strings.ReplaceAll(strings.ToLower(part), "%2e", ".")
		switch dot {
		case ".":
			if i == len(parts)-1 {
				stack = append(stack, "")
			}
		case "..":
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			if i == len(parts)-1 {
				stack = append(stack, "")
			}
		default:
			stack = append(stack, part)
		}
	}
	return strings.Join(stack, "/") == ""
}
func ipv6Text(ip net.IP) string {
	b := ip.To16()
	words := make([]string, 8)
	bestStart, bestLen := -1, 1
	for i := 0; i < 8; i++ {
		words[i] = strconv.FormatUint(uint64(b[2*i])<<8|uint64(b[2*i+1]), 16)
	}
	for i := 0; i < 8; {
		if words[i] != "0" {
			i++
			continue
		}
		j := i
		for j < 8 && words[j] == "0" {
			j++
		}
		if j-i > bestLen {
			bestStart, bestLen = i, j-i
		}
		i = j
	}
	if bestStart < 0 {
		return strings.Join(words, ":")
	}
	return strings.Join(words[:bestStart], ":") + "::" + strings.Join(words[bestStart+bestLen:], ":")
}
func normalizeIPv4(host string) (string, bool, bool) {
	parts := strings.Split(strings.TrimSuffix(host, "."), ".")
	parse := func(s string) (uint64, bool) {
		base := 10
		if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
			base = 16
			s = s[2:]
		} else if len(s) > 1 && s[0] == '0' {
			base = 8
			s = s[1:]
		}
		if s == "" {
			return 0, true
		}
		n, e := strconv.ParseUint(s, base, 32)
		return n, e == nil
	}
	last := parts[len(parts)-1]
	_, lastNumber := parse(last)
	decimal := last != ""
	for _, r := range last {
		if r < '0' || r > '9' {
			decimal = false
		}
	}
	if !lastNumber && !decimal {
		return "", false, false
	}
	if len(parts) > 4 {
		return "", true, false
	}
	nums := make([]uint64, len(parts))
	for i, s := range parts {
		n, ok := parse(s)
		if !ok || (i < len(parts)-1 && n > 255) {
			return "", true, false
		}
		nums[i] = n
	}
	limit := uint64(1) << (8 * (5 - len(parts)))
	if nums[len(nums)-1] >= limit {
		return "", true, false
	}
	n := nums[len(nums)-1]
	for i := 0; i < len(nums)-1; i++ {
		n += nums[i] << uint(8*(3-i))
	}
	return fmt.Sprintf("%d.%d.%d.%d", byte(n>>24), byte(n>>16), byte(n>>8), byte(n)), true, true
}
