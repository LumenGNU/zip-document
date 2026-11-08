#!/usr/bin/bash

# Archive with one entry whose file name is empty (file name length 0).
# APPNOTE 4.4.17.1: "If input came from standard input, there is no file
# name field." Info-ZIP zip does not follow this and names stdin input "-",
# so we add stdin input and then rename "-" to "" with zipnote
# (it rewrites both the local header and the central directory record).

set -euo pipefail
cd "$(dirname "$0")"

# Own mktemp directory: nothing else can be inside, so plain rm -r is safe.
tmp=$(mktemp -d -p .)
trap 'rm -r -- "$tmp"' EXIT

printf 'from stdin\n' | zip -q0X "$tmp/out.zip" -

zipnote "$tmp/out.zip" | sed 's/^@ -$/&\n@=/' > "$tmp/notes"
zipnote -w "$tmp/out.zip" < "$tmp/notes"

mv -f -- "$tmp/out.zip" out.zip
../tools/hexdump-zip/hexdump-zip out.zip out.hex
