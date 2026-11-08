#!/usr/bin/bash

# Archive with two different entries under the same name "file.txt".
# Info-ZIP zip refuses to add a duplicate name, so we add two files with
# names of equal length and then rename the second one with zipnote
# (it rewrites both the local header and the central directory record).

set -euo pipefail
cd "$(dirname "$0")"

# Own mktemp directory: nothing else can be inside, so plain rm -r is safe.
tmp=$(mktemp -d -p .)
trap 'rm -r -- "$tmp"' EXIT

printf 'first\n'  > "$tmp/file.txt"
printf 'second\n' > "$tmp/fil2.txt"
(cd "$tmp" && zip -q0X out.zip file.txt fil2.txt)

zipnote "$tmp/out.zip" | sed 's/^@ fil2\.txt$/&\n@=file.txt/' > "$tmp/notes"
zipnote -w "$tmp/out.zip" < "$tmp/notes"

mv -f -- "$tmp/out.zip" out.zip
../tools/hexdump-zip/hexdump-zip out.zip out.hex
