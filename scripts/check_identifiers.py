#!/usr/bin/env python3
"""Check names against SQLite's keyword list (D1 uses SQLite's parser).

Usage:
  check_identifiers.py NAME [NAME ...]     check names given as arguments
  check_identifiers.py --scan FILE.sql     find unquoted table/column names that are keywords
  check_identifiers.py --list              print all keywords

Exit code 1 if any keyword is found, so it can be used in CI.

Keyword list: https://sqlite.org/lang_keywords.html (147 entries, page last updated 2022-11-26).
SQLite adds keywords over time, so quote any identifier that is an English word.
--scan is a heuristic (it looks at CREATE TABLE bodies and ALTER TABLE ... ADD COLUMN),
not a full SQL parser.
"""
import re
import sys

KEYWORDS = set("""
ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY
CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE
CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP
EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM
FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT
INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING
NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY
RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK
ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE
UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT
""".split())

CONSTRAINT_STARTERS = {"CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"}


def is_keyword(name: str) -> bool:
    return name.upper() in KEYWORDS


def split_top_level(body: str):
    """Split a CREATE TABLE body on commas that are not inside parentheses or quotes."""
    parts, depth, cur, quote = [], 0, [], None
    for ch in body:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"`":
            quote = ch
            cur.append(ch)
        elif ch == "[":
            quote = "]"
            cur.append(ch)
        elif ch == "(":
            depth += 1
            cur.append(ch)
        elif ch == ")":
            depth -= 1
            cur.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        parts.append("".join(cur))
    return parts


def strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", sql)


def scan(sql: str):
    """Yield (kind, context, name) for unquoted keyword identifiers."""
    sql = strip_comments(sql)
    ident = r"([A-Za-z_][A-Za-z0-9_]*)"

    for m in re.finditer(
        r"CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?"
        + r"(\"[^\"]+\"|\[[^\]]+\]|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\(",
        sql,
        flags=re.I,
    ):
        table = m.group(1)
        if not table[0] in "\"[`" and is_keyword(table):
            yield ("table", table, table)
        # find matching close paren
        depth, i = 1, m.end()
        while i < len(sql) and depth:
            depth += {"(": 1, ")": -1}.get(sql[i], 0)
            i += 1
        body = sql[m.end(): i - 1]
        for part in split_top_level(body):
            tok = part.strip().split(None, 1)
            if not tok:
                continue
            first = tok[0]
            if first.upper() in CONSTRAINT_STARTERS:
                continue
            first_bare = re.match(ident + r"$", first)
            if first_bare and is_keyword(first_bare.group(1)):
                yield ("column", table, first_bare.group(1))

    for m in re.finditer(r"ADD\s+COLUMN\s+" + ident, sql, flags=re.I):
        if is_keyword(m.group(1)):
            yield ("column", "ALTER TABLE", m.group(1))


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--list":
        print("\n".join(sorted(KEYWORDS)))
        return 0
    if argv[0] == "--scan":
        if len(argv) != 2:
            print("usage: check_identifiers.py --scan FILE.sql", file=sys.stderr)
            return 2
        with open(argv[1], encoding="utf-8") as fh:
            hits = list(scan(fh.read()))
        for kind, ctx, name in hits:
            print(f'{kind} {name!r} in {ctx}: SQLite keyword, quote it as "{name}"')
        if not hits:
            print("No unquoted keyword identifiers found (heuristic scan).")
        return 1 if hits else 0

    bad = 0
    for name in argv:
        if is_keyword(name):
            print(f'KEYWORD  {name}  -> quote it: "{name}"')
            bad = 1
        else:
            print(f"ok       {name}")
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
