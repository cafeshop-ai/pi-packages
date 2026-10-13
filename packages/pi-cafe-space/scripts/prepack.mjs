// npm pack archives its current directory; the source checkout is deliberately
// not the prebuilt release layout. Avoid shipping an old dist or source secrets.
// npm run pack also invokes prepack; allow that workflow to reach our verified
// staging packer. Only raw npm pack/publish would archive this source directory.
if (process.env.npm_command !== 'run-script') {
console.error('Package this source checkout with "npm run pack" (optionally -- --platforms linux-amd64,windows-amd64). It builds and verifies the Go/React release, then writes the .tgz under .refactor/release/pack-*.');
process.exitCode = 1;
}
