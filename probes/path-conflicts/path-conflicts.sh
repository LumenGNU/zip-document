#!/usr/bin/bash

# Archive where several entries claim the same path (SPEC §4.2, §4.3):
# normalization collisions (a/b.txt, a//b.txt, ./a/b.txt), a file next to
# a directory with the same name (a and a/), and a file claiming the root (.).
# Info-ZIP zip refuses such names, so we add placeholder files and rename
# them with zipnote (it rewrites both the local header and the central
# directory record).
#
# Claimants of a path, in order: the directory (if the path is one), then
# file entries in central directory order. Expected zip:-URIs, A = archive URI:
#
#   #  name        path      claimant  URI
#   0  a           a         2         zip://2/a?A
#   1  a/b.txt     a/b.txt   1         zip:/a/b.txt?A
#   2  a//b.txt    a/b.txt   2         zip://2/a/b.txt?A
#   3  ./a/b.txt   a/b.txt   3         zip://3/a/b.txt?A
#   4  a/          a         1 (dir)   zip:/a?A
#   5  .           (root)    2         zip://2/?A

set -euo pipefail
cd "$(dirname "$0")"

# Own mktemp directory: nothing else can be inside, so plain rm -r is safe.
tmp=$(mktemp -d -p .)
trap 'rm -r -- "$tmp"' EXIT

printf 'a\n'         > "$tmp/f0"
printf 'a/b.txt\n'   > "$tmp/f1"
printf 'a//b.txt\n'  > "$tmp/f2"
printf './a/b.txt\n' > "$tmp/f3"
mkdir                  "$tmp/d4"
printf '.\n'         > "$tmp/f5"
(cd "$tmp" && zip -q0X out.zip f0 f1 f2 f3 d4 f5)

zipnote "$tmp/out.zip" | sed \
  -e 's|^@ f0$|&\n@=a|' \
  -e 's|^@ f1$|&\n@=a/b.txt|' \
  -e 's|^@ f2$|&\n@=a//b.txt|' \
  -e 's|^@ f3$|&\n@=./a/b.txt|' \
  -e 's|^@ d4/$|&\n@=a/|' \
  -e 's|^@ f5$|&\n@=.|' \
  > "$tmp/notes"
zipnote -w "$tmp/out.zip" < "$tmp/notes"

mv -f -- "$tmp/out.zip" out.zip
../tools/hexdump-zip/hexdump-zip out.zip out.hex
