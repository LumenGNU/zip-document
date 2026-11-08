#!/usr/bin/bash

# Where do common extractors put entries whose names contain "", "." or ".." segments?
# Each name goes into its own archive and is extracted alone, so nothing overwrites anything.
# Tools: Python zipfile, Info-ZIP unzip, 7-Zip, bsdtar (libarchive). Result: out.txt.

set -uo pipefail
cd "$(dirname "$0")"

# Own mktemp directory: nothing else can be inside, so plain rm -r is safe.
tmp=$(mktemp -d -p .)
trap 'rm -r -- "$tmp"' EXIT

names=('a/b.txt' 'a/./b.txt' 'a//b.txt' './a/b.txt' '/a/b.txt' 'a/c/../b.txt' '../a/b.txt' 'x/../../y.txt')

{
  for tool in python unzip 7z bsdtar; do
    printf '%s: %s\n' "$tool" "$(case $tool in
      python) python3 -c 'import sys; print(sys.version.split()[0])' ;;
      unzip) unzip -v | head -1 ;;
      7z) 7z | grep -m1 -o '7-Zip[^:]*' ;;
      bsdtar) bsdtar --version ;;
    esac)"
  done
  echo
  printf '%-19s %-14s %-14s %-14s %s\n' 'имя' 'python' 'unzip' '7z' 'bsdtar'
  i=0
  for name in "${names[@]}"; do
    i=$((i + 1))
    d="$tmp/$i"; mkdir -p "$d"/{python,unzip,7z,bsdtar}
    python3 -I -c 'import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr(sys.argv[2], "x")' "$d/t.zip" "$name"
    python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$d/t.zip" "$d/python" 2>/dev/null
    (cd "$d/unzip" && unzip -q ../t.zip >/dev/null 2>&1)
    (cd "$d/7z" && 7z x -y ../t.zip >/dev/null 2>&1)
    (cd "$d/bsdtar" && bsdtar -xf ../t.zip >/dev/null 2>&1)
    row=$(printf '%-16s' "$name")
    for tool in python unzip 7z bsdtar; do
      got=$(cd "$d/$tool" && find . -type f | sed 's|^\./||' | tr '\n' ' ')
      # 7z and others may write outside the target dir for "..": look one level up too
      [ -z "$got" ] && got=$(cd "$d" && find . -maxdepth 1 -type f ! -name t.zip | sed 's|^\./|../|' | tr '\n' ' ')
      row+=$(printf ' %-14s' "${got:-отказ}")
    done
    echo "$row"
  done
} > out.txt
cat out.txt
