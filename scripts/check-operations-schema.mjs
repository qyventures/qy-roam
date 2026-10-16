import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const productionReadiness = readFileSync(new URL('../lib/productionReadiness.ts', import.meta.url), 'utf8');

// Checkout and the migration publish opposite sides of one compatibility
// handshake. Catch a one-sided version bump locally: otherwise a release can
// either accept payment against stale database logic or remain unnecessarily
// unavailable after the matching migration is installed.
const applicationSchemaVersion = productionReadiness.match(/const REQUIRED_ORDER_INTEGRITY_SCHEMA_VERSION = (\d+);/)?.[1];
const databaseSchemaVersion = schema.match(/create or replace function public\.qy_order_integrity_schema_version\(\)[\s\S]*?select (\d+);/)?.[1];
assert.ok(applicationSchemaVersion, 'Missing application order-integrity schema version');
assert.ok(databaseSchemaVersion, 'Missing database order-integrity schema version');
assert.equal(applicationSchemaVersion, databaseSchemaVersion, 'Application and database order-integrity schema versions must match');

// This guard runs without production database credentials, so it cannot ask
// PostgreSQL to compile the migration. Still reject common damaging classes
// of hand-edited PL/pgSQL breakage before deployment: an unterminated
// dollar-quoted function body, unbalanced control-flow blocks, and unmatched
// parentheses. Presence-only checks below would otherwise pass these and leave
// a clean Supabase install failing partway through schema application.
export function validatePlpgsqlStructure(sql) {
  const dollarDelimiter = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g;
  const blocks = [];
  let match;

  while ((match = dollarDelimiter.exec(sql)) !== null) {
    const opening = { delimiter: match[0], start: match.index, bodyStart: dollarDelimiter.lastIndex };
    // A function body can itself contain a differently tagged dollar-quoted
    // string (usually dynamic SQL). Only the exact opening tag closes it.
    const closingAt = sql.indexOf(opening.delimiter, opening.bodyStart);
    assert.ok(closingAt >= 0, `Unterminated SQL dollar-quoted block beginning at byte ${opening.start}`);
    blocks.push({
      prefix: sql.slice(Math.max(0, opening.start - 300), opening.start),
      body: sql.slice(opening.bodyStart, closingAt),
      // PostgreSQL accepts function attributes on either side of AS. Retain
      // the bounded text after the body so `AS $$...$$ LANGUAGE plpgsql`
      // receives the same release validation as this schema's current
      // `LANGUAGE plpgsql AS $$...$$` convention.
      suffix: sql.slice(closingAt + opening.delimiter.length, closingAt + opening.delimiter.length + 300),
    });
    dollarDelimiter.lastIndex = closingAt + opening.delimiter.length;
  }

  for (const { prefix, body, suffix } of blocks) {
    if (!/language\s+plpgsql/i.test(prefix) && !/^\s*language\s+plpgsql\b/i.test(suffix)) continue;
    // Remove text that cannot contain control-flow tokens. PostgreSQL strings
    // escape a quote by doubling it; comments can contain arbitrary examples.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\r\n]*/g, ' ')
      .replace(/'(?:''|[^'])*'/g, ' ')
      .replace(/"(?:""|[^"])*"/g, ' ');
    const tokens = code.match(/\bend\s+if\b|\bif\b/gi) || [];
    let depth = 0;
    for (const token of tokens) {
      if (/^end/i.test(token)) {
        depth -= 1;
        assert.ok(depth >= 0, 'PL/pgSQL function contains END IF without a matching IF');
      } else {
        depth += 1;
      }
    }
    assert.equal(depth, 0, 'PL/pgSQL function contains an IF without a matching END IF');

    const loopTokens = code.match(/\bend\s+loop\b|\bloop\b/gi) || [];
    depth = 0;
    for (const token of loopTokens) {
      if (/^end/i.test(token)) {
        depth -= 1;
        assert.ok(depth >= 0, 'PL/pgSQL function contains END LOOP without a matching LOOP');
      } else {
        depth += 1;
      }
    }
    assert.equal(depth, 0, 'PL/pgSQL function contains a LOOP without a matching END LOOP');

    // IF/LOOP counts alone cannot see a missing function-level END, a broken
    // nested BEGIN block, or a CASE expression closed in the wrong order.
    // Track the complete block stack so a migration cannot pass this offline
    // gate with locally balanced keywords that PostgreSQL will still reject.
    // SQL CASE expressions use bare END, while procedural CASE may use END
    // CASE; a bare END can therefore close only the current CASE or BEGIN.
    const blockTokens = code.match(/\bend\s+(?:if|loop|case)\b|\b(?:begin|if|loop|case|end)\b/gi) || [];
    const blocks = [];
    for (const rawToken of blockTokens) {
      const token = rawToken.toLowerCase().replace(/\s+/g, ' ');
      if (token === 'begin' || token === 'if' || token === 'loop' || token === 'case') {
        blocks.push(token);
        continue;
      }
      const expected = token === 'end' ? null : token.slice(4);
      const opening = blocks.pop();
      assert.ok(opening, `PL/pgSQL function contains ${token.toUpperCase()} without an opening block`);
      if (expected) {
        assert.equal(opening, expected, `PL/pgSQL function closes ${opening.toUpperCase()} with ${token.toUpperCase()}`);
      } else {
        assert.ok(opening === 'begin' || opening === 'case', `PL/pgSQL function closes ${opening.toUpperCase()} with bare END`);
      }
    }
    assert.deepEqual(blocks, [], `PL/pgSQL function contains an unclosed ${blocks.at(-1)?.toUpperCase()} block`);

    // Balanced keywords are not sufficient syntax evidence. PostgreSQL
    // requires procedural block terminators to be complete statements, so a
    // hand edit such as `END IF` followed by another statement (without the
    // semicolon) would otherwise pass every stack/count check above and fail
    // only after the production migration had already started. Strings and
    // comments were removed from `code`, keeping these checks scoped to
    // executable PL/pgSQL rather than documentation examples.
    for (const terminator of code.matchAll(/\bend\s+(if|loop|case)\b/gi)) {
      const remainder = code.slice((terminator.index ?? 0) + terminator[0].length);
      assert.match(
        remainder,
        /^\s*;/,
        `PL/pgSQL ${terminator[0].toUpperCase()} block terminator is missing a semicolon`,
      );
    }

    // A duplicated condition terminator such as `) then` is not visible to
    // the keyword-only check above. Track parentheses after stripping strings
    // and comments so malformed trigger expressions cannot pass the offline
    // release guard merely because their IF and END IF tokens still balance.
    let parenthesisDepth = 0;
    for (const character of code) {
      if (character === '(') parenthesisDepth += 1;
      if (character === ')') {
        parenthesisDepth -= 1;
        assert.ok(parenthesisDepth >= 0, 'PL/pgSQL function contains an unmatched closing parenthesis');
      }
    }
    assert.equal(parenthesisDepth, 0, 'PL/pgSQL function contains an unmatched opening parenthesis');
  }
}

validatePlpgsqlStructure(schema);

// Every checkout, idempotency, delivery and operations guarantee ultimately
// depends on the base relations compiling first. Presence checks can still
// find a table name after a missing closing parenthesis or semicolon has joined
// two declarations together, leaving a clean production migration only
// partially applied. Validate the deliberately simple CREATE TABLE form used
// by this repository before examining its dependent indexes and triggers.
export function validateCreateTableStatements(sql) {
  const topLevelSql = sql
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
  const starts = topLevelSql.match(/\bcreate\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\b/gi) || [];
  const statements = topLevelSql.match(/\bcreate\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\b[\s\S]*?;/gi) || [];
  assert.equal(statements.length, starts.length, 'CREATE TABLE statement is missing its semicolon');

  const names = new Set();
  for (const statement of statements) {
    assert.doesNotMatch(
      statement.replace(/^\s*create\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\b/i, ''),
      /\bcreate\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\b/i,
      'CREATE TABLE statement contains another CREATE TABLE before its terminator',
    );
    const declaration = statement.match(
      /^\s*create\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)\s*\(([\s\S]+)\)\s*;\s*$/i,
    );
    assert.ok(declaration, 'Malformed CREATE TABLE statement');

    // Column defaults and CHECK expressions can contain parentheses. Remove
    // quoted literals and count the remaining delimiters so a truncated
    // nested expression cannot masquerade as the table's final closing `)`.
    const definition = declaration[2]
      .replace(/'(?:''|[^'])*'/g, ' ')
      .replace(/"(?:""|[^"])*"/g, ' ');
    let depth = 0;
    for (const character of definition) {
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        assert.ok(depth >= 0, 'CREATE TABLE statement contains an unmatched closing parenthesis');
      }
    }
    assert.equal(depth, 0, 'CREATE TABLE statement contains an unmatched opening parenthesis');

    const name = declaration[1].toLowerCase();
    assert.ok(!names.has(name), `Duplicate CREATE TABLE declaration: ${name}`);
    names.add(name);
  }
}

validateCreateTableStatements(schema);
validateCreateTableStatements(`
  create table if not exists public.example (
    id bigint primary key,
    amount numeric(12,2) check (amount >= 0)
  );
`);
assert.throws(
  () => validateCreateTableStatements(`
    create table public.example (id bigint)
    create table public.second (id bigint);
  `),
  /missing its semicolon/,
);
assert.throws(
  () => validateCreateTableStatements(
    'create table public.example (id bigint, check ((id > 0));',
  ),
  /unmatched opening parenthesis/,
);
assert.throws(
  () => validateCreateTableStatements(`
    create table public.example (id bigint);
    create table if not exists public.example (id bigint);
  `),
  /Duplicate CREATE TABLE declaration/,
);

// Top-level DDL can be damaged independently of the PL/pgSQL bodies above.
// In particular, a truncated CREATE INDEX followed by another CREATE INDEX
// is valid enough for presence-only contract checks to find both names, but
// PostgreSQL will stop the clean-install migration at the first statement.
// Keep this deliberately narrow: it validates the schema's index declarations
// without pretending to be a general SQL parser.
export function validateCreateIndexStatements(sql) {
  const topLevelSql = sql
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
  const starts = topLevelSql.match(/\bcreate\s+(?:unique\s+)?index\b/gi) || [];
  const statements = topLevelSql.match(/\bcreate\s+(?:unique\s+)?index\b[\s\S]*?;/gi) || [];
  assert.equal(statements.length, starts.length, 'CREATE INDEX statement is missing its semicolon');

  const names = new Set();
  for (const statement of statements) {
    assert.doesNotMatch(
      statement.replace(/^\s*create\s+(?:unique\s+)?index\b/i, ''),
      /\bcreate\s+(?:unique\s+)?index\b/i,
      'CREATE INDEX statement contains another CREATE INDEX before its terminator',
    );
    const declaration = statement.match(
      /^\s*create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([A-Za-z_][A-Za-z0-9_$]*)\s+on\s+(?:only\s+)?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?\s*\([\s\S]+\)(?:\s+where\s+[\s\S]+)?\s*;\s*$/i,
    );
    assert.ok(declaration, 'Malformed CREATE INDEX statement');
    const name = declaration[1].toLowerCase();
    assert.ok(!names.has(name), `Duplicate CREATE INDEX declaration: ${name}`);
    names.add(name);
  }
}

validateCreateIndexStatements(schema);
validateCreateIndexStatements(`
  create index if not exists example_created_idx
    on public.example(created_at desc)
    where deleted_at is null;
`);
assert.throws(
  () => validateCreateIndexStatements(`
    create index if not exists example_created_idx
    create index if not exists example_status_idx on public.example(status);
  `),
  /missing its semicolon/,
);
assert.throws(
  () => validateCreateIndexStatements('create index if not exists example_created_idx;'),
  /Malformed CREATE INDEX/,
);
assert.throws(
  () => validateCreateIndexStatements(`
    create index example_idx on public.example(id);
    create index example_idx on public.example(created_at);
  `),
  /Duplicate CREATE INDEX declaration/,
);

// Triggers enforce the paid-order, delivery-ledger, inventory-custody and CRM
// boundaries in this migration. A truncated declaration can still leave its
// name, table and function visible to the contract checks below while making
// PostgreSQL stop before later functions and the compatibility marker are
// installed. Validate each complete top-level declaration and reject duplicate
// names, which would otherwise make a clean install fail at the second CREATE.
export function validateCreateTriggerStatements(sql) {
  const topLevelSql = sql
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
  const starts = topLevelSql.match(/\bcreate\s+(?:constraint\s+)?trigger\b/gi) || [];
  const statements = topLevelSql.match(/\bcreate\s+(?:constraint\s+)?trigger\b[\s\S]*?;/gi) || [];
  assert.equal(statements.length, starts.length, 'CREATE TRIGGER statement is missing its semicolon');

  const names = new Set();
  for (const statement of statements) {
    assert.doesNotMatch(
      statement.replace(/^\s*create\s+(?:constraint\s+)?trigger\b/i, ''),
      /\bcreate\s+(?:constraint\s+)?trigger\b/i,
      'CREATE TRIGGER statement contains another CREATE TRIGGER before its terminator',
    );
    const declaration = statement.match(
      /^\s*create\s+(?:constraint\s+)?trigger\s+([A-Za-z_][A-Za-z0-9_$]*)\s+(?:before|after|instead\s+of)\s+[\s\S]+?\s+on\s+(?:only\s+)?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?\s+[\s\S]*?execute\s+(?:function|procedure)\s+[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?\s*\([^;]*\)\s*;\s*$/i,
    );
    assert.ok(declaration, 'Malformed CREATE TRIGGER statement');
    const name = declaration[1].toLowerCase();
    assert.ok(!names.has(name), `Duplicate CREATE TRIGGER declaration: ${name}`);
    names.add(name);
  }
}

validateCreateTriggerStatements(schema);
validateCreateTriggerStatements(`
  create trigger example_audit
  after insert or update of status on public.example
  for each row execute function public.audit_example();
`);
assert.throws(
  () => validateCreateTriggerStatements(`
    create trigger example_audit after insert on public.example
    for each row execute function public.audit_example()
    create trigger example_notify after update on public.example
    for each row execute function public.notify_example();
  `),
  /missing its semicolon/,
);
assert.throws(
  () => validateCreateTriggerStatements(
    'create trigger example_audit after insert on public.example for each row;',
  ),
  /Malformed CREATE TRIGGER/,
);
assert.throws(
  () => validateCreateTriggerStatements(`
    create trigger example_audit after insert on public.example
    for each row execute function public.audit_example();
    create trigger example_audit after update on public.example
    for each row execute function public.audit_example();
  `),
  /Duplicate CREATE TRIGGER declaration/,
);

// The order ledger's payment, fulfilment, delivery-reference and Stripe
// identity invariants are installed as named ALTER TABLE constraints. A
// missing semicolon can join two declarations into one broken statement while
// leaving every expected constraint name visible to the presence checks
// below. Validate the complete declarations and reject a copied name on the
// same table before deployment starts applying this migration.
export function validateAddConstraintStatements(sql) {
  const topLevelSql = sql
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
  const starts = topLevelSql.match(/\balter\s+table\s+(?:only\s+)?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?\s+add\s+constraint\b/gi) || [];
  const statements = topLevelSql.match(/\balter\s+table\s+(?:only\s+)?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?\s+add\s+constraint\b[\s\S]*?;/gi) || [];
  assert.equal(statements.length, starts.length, 'ADD CONSTRAINT statement is missing its semicolon');

  const declarations = new Set();
  for (const statement of statements) {
    assert.doesNotMatch(
      statement.replace(/^\s*alter\s+table\b/i, ''),
      /\balter\s+table\s+(?:only\s+)?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?\s+add\s+constraint\b/i,
      'ADD CONSTRAINT statement contains another ADD CONSTRAINT before its terminator',
    );
    const declaration = statement.match(
      /^\s*alter\s+table\s+(?:only\s+)?([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)\s+add\s+constraint\s+([A-Za-z_][A-Za-z0-9_$]*)\s+([\s\S]+?)\s*;\s*$/i,
    );
    assert.ok(declaration, 'Malformed ADD CONSTRAINT statement');
    assert.match(declaration[3], /^(?:check|unique|primary\s+key|foreign\s+key|exclude)\b/i, 'Unsupported ADD CONSTRAINT declaration');

    // Parentheses in constraint expressions and column lists must balance.
    // String literals were retained above because their contents are part of
    // the expression; remove them before counting syntax delimiters.
    const expression = declaration[3].replace(/'(?:''|[^'])*'/g, ' ');
    let depth = 0;
    for (const character of expression) {
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        assert.ok(depth >= 0, 'ADD CONSTRAINT statement contains an unmatched closing parenthesis');
      }
    }
    assert.equal(depth, 0, 'ADD CONSTRAINT statement contains an unmatched opening parenthesis');

    const identity = `${declaration[1].toLowerCase()}:${declaration[2].toLowerCase()}`;
    assert.ok(!declarations.has(identity), `Duplicate ADD CONSTRAINT declaration: ${identity}`);
    declarations.add(identity);
  }
}

validateAddConstraintStatements(schema);
validateAddConstraintStatements(`
  alter table public.example add constraint example_positive_check check (value > 0) not valid;
`);
assert.throws(
  () => validateAddConstraintStatements(`
    alter table public.example add constraint example_positive_check check (value > 0)
    alter table public.example add constraint example_label_check check (label <> '');
  `),
  /missing its semicolon/,
);
assert.throws(
  () => validateAddConstraintStatements(
    'alter table public.example add constraint example_positive_check check (value > 0;',
  ),
  /unmatched opening parenthesis/,
);
assert.throws(
  () => validateAddConstraintStatements(`
    alter table public.example add constraint example_positive_check check (value > 0);
    alter table public.example add constraint example_positive_check check (value >= 0);
  `),
  /Duplicate ADD CONSTRAINT declaration/,
);

// Keep both halves of the lightweight parser covered in the release command
// itself; the broader integrity suite also exercises these exported guards.
validatePlpgsqlStructure(`
  create function public.example() returns trigger language plpgsql as $$
  begin
    if new.value is not null and (new.value > 0 or new.value = -1) then
      return new;
    end if;
    return old;
  end;
  $$;
`);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns trigger language plpgsql as $$
    begin
      if new.value is not null and (new.value > 0) then
      ) then
        return new;
      end if;
      return old;
    end;
    $$;
  `),
  /unmatched closing parenthesis/,
);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns void as $$
    begin
      loop
        return;
    end;
    $$ language plpgsql;
  `),
  /LOOP without a matching END LOOP/,
);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns void language plpgsql as $$
    begin
      return;
    $$;
  `),
  /unclosed BEGIN block/,
);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns integer language plpgsql as $$
    begin
      return case when true then 1 else 0;
    end;
    $$;
  `),
  /closes CASE with bare END|unclosed BEGIN block/,
);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns trigger language plpgsql as $$
    begin
      if new.value is not null then
        return new;
      end if
      return old;
    end;
    $$;
  `),
  /END IF block terminator is missing a semicolon/,
);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns void language plpgsql as $$
    begin
      loop
        exit;
      end loop -- comments cannot supply the missing statement delimiter
      return;
    end;
    $$;
  `),
  /END LOOP block terminator is missing a semicolon/,
);

// PostgreSQL rejects an ON CONFLICT update that assigns the same target
// column twice. This is easy to introduce while editing the long, safety-
// critical paid-order upserts below, and the duplicate can hide among comments
// while all presence-based contract checks continue to pass. We do not have a
// production database available in the build workspace, so parse the bounded
// assignment lists here and fail before a partially applied schema reaches it.
export function validateOnConflictAssignments(sql) {
  const clause = /\bon\s+conflict\b[\s\S]*?\bdo\s+update\s+set\b/gi;
  let match;

  while ((match = clause.exec(sql)) !== null) {
    const assignmentsStart = clause.lastIndex;
    let depth = 0;
    let quote = null;
    let lineComment = false;
    let blockComment = false;
    let end = sql.length;

    for (let index = assignmentsStart; index < sql.length; index += 1) {
      const char = sql[index];
      const next = sql[index + 1];
      if (lineComment) {
        if (char === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === '*' && next === '/') { blockComment = false; index += 1; }
        continue;
      }
      if (quote) {
        if (char === quote && next === quote) { index += 1; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '-' && next === '-') { lineComment = true; index += 1; continue; }
      if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (depth === 0 && char === ';') { end = index; break; }
      else if (depth === 0 && /^\sreturning\b/i.test(sql.slice(index))) { end = index; break; }
    }

    const list = sql.slice(assignmentsStart, end)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\r\n]*/g, ' ');
    const columns = [];
    let itemStart = 0;
    depth = 0;
    quote = null;
    for (let index = 0; index <= list.length; index += 1) {
      const char = list[index];
      const next = list[index + 1];
      if (quote) {
        if (char === quote && next === quote) { index += 1; continue; }
        if (char === quote) quote = null;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if ((char === ',' && depth === 0) || index === list.length) {
        const assignment = list.slice(itemStart, index).trim();
        const column = assignment.match(/^([a-z_][a-z0-9_]*)\s*=/i)?.[1]?.toLowerCase();
        assert.ok(column, `Unable to parse ON CONFLICT assignment: ${assignment.slice(0, 80)}`);
        columns.push(column);
        itemStart = index + 1;
      }
    }
    const duplicates = columns.filter((column, index) => columns.indexOf(column) !== index);
    assert.deepEqual([...new Set(duplicates)], [], `ON CONFLICT assigns a target column more than once: ${[...new Set(duplicates)].join(', ')}`);
    clause.lastIndex = end;
  }
}

validateOnConflictAssignments(schema);

// PostgreSQL permits only one RETURNING clause per data-modification
// statement. A duplicated clause is easy to miss at the end of a long
// INSERT ... ON CONFLICT upsert and prevents the enclosing function from
// compiling, potentially leaving a production schema migration half-applied.
// Catch that specific copy/paste failure offline because this release check
// intentionally runs without production database credentials.
export function validateDuplicateReturningClauses(sql) {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
  assert.doesNotMatch(
    withoutComments,
    /\breturning\b[^;]*;\s*returning\b/i,
    'SQL statement contains a duplicate RETURNING clause',
  );
}

validateDuplicateReturningClauses(schema);

// Named function arguments share one namespace in PostgreSQL. A duplicated
// RPC parameter prevents CREATE OR REPLACE FUNCTION from compiling, but can
// hide easily in the longer checkout and fulfilment signatures while every
// body/contract check below still passes. Repository RPC arguments use the
// explicit `p_` convention, so validate that narrow production contract
// without trying to implement PostgreSQL's complete type grammar offline.
export function validateDuplicateFunctionParameters(sql) {
  const declaration = /\bcreate\s+(?:or\s+replace\s+)?function\s+[a-z_][a-z0-9_.]*\s*\(([\s\S]*?)\)\s*returns\b/gi;
  let match;
  while ((match = declaration.exec(sql)) !== null) {
    const header = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\r\n]*/g, ' ');
    const parameters = [...header.matchAll(/(?:^|,)\s*(p_[a-z_][a-z0-9_]*)\s+/gi)]
      .map((parameter) => parameter[1].toLowerCase());
    const duplicates = parameters.filter((parameter, index) => parameters.indexOf(parameter) !== index);
    assert.deepEqual(
      [...new Set(duplicates)],
      [],
      `Function declares a parameter more than once: ${[...new Set(duplicates)].join(', ')}`,
    );
  }
}

validateDuplicateFunctionParameters(schema);

// Keep the release-command path self-testing, like the other lightweight SQL
// validators in this file. Comments between arguments must not hide a copied
// parameter name.
validateDuplicateFunctionParameters(`
  create function public.example(p_value integer, p_label text default 'ok')
  returns void language sql as $$ select $$;
`);
assert.throws(
  () => validateDuplicateFunctionParameters(`
    create or replace function public.example(
      p_value integer,
      p_label text, -- accidental copy follows
      p_value integer default 0
    ) returns void language sql as $$ select $$;
  `),
  /parameter more than once: p_value/,
);

// Keep this release guard covered by the command deployment actually runs.
assert.throws(
  () => validateDuplicateReturningClauses(`
    insert into example(id) values (1)
    returning * into saved;
    returning * into saved;
  `),
  /duplicate RETURNING clause/,
);

// Keep the guard itself honest: this is a release check, so a parser
// regression must fail locally instead of silently weakening deployment.
validateOnConflictAssignments(`
  insert into example(id, email) values (1, 'a@example.com')
  on conflict (id) do update set
    email = case when (example.email is null) then excluded.email else example.email end,
    updated_at = now()
  returning id;
`);
assert.throws(
  () => validateOnConflictAssignments(`
    insert into example(id, email) values (1, 'a@example.com')
    on conflict (id) do update set email = excluded.email, -- accidental copy
      email = lower(excluded.email)
    returning id;
  `),
  /assigns a target column more than once: email/,
);

const requiredContracts = [
  'create table if not exists public.inventory_items',
  'create table if not exists public.inventory_movements',
  'create or replace function public.qy_adjust_inventory',
  'create or replace function public.qy_transition_pocket_wifi_order',
  "and status = 'available'",
  'selected Pocket WiFi inventory item is not available for dispatch',
  'orders_pocket_wifi_custody_reference_shape_check',
  'create or replace function public.qy_create_manual_pocket_wifi_order',
  'create or replace function public.qy_create_inventory_item',
  'create table if not exists public.customers',
  'create or replace function public.qy_reconcile_customer_paid_totals',
  'create or replace function public.qy_reconcile_customer_from_paid_order',
  'create trigger qy_reconcile_customer_from_paid_order',
  'create or replace function public.qy_order_integrity_schema_ready',
  'grant execute on function public.qy_order_integrity_schema_ready() to service_role',
  "tgenabled in ('O', 'A')",
  'create or replace function public.qy_order_integrity_schema_version',
  'grant execute on function public.qy_order_integrity_schema_version() to service_role',
  'create or replace function public.qy_claim_stripe_event',
  'grant execute on function public.qy_claim_stripe_event(text,text,text) to service_role',
  "to_regprocedure('public.qy_persist_stripe_esim_order(text,text,text,text,text,numeric,text,text,text,text,text,jsonb,timestamptz,boolean)') is not null",
  "to_regprocedure('public.qy_persist_stripe_pocket_wifi_order(text,text,text,text,text,numeric,text,text,date,date,text,jsonb,timestamptz,boolean,text)') is not null",
  'stripe_events_event_id_check',
  'stripe_events_session_id_check',
  'stripe_events_event_type_check',
  'stripe_events_failure_timestamp_check',
  'stripe_events_processed_failure_check',
  'orders_session_id_format_check',
  "coalesce(btrim(shipping_address ->> 'postal_code') ~ '^[0-9]{6}$', false)",
  'create trigger qy_validate_order_payment_confirmation_time',
  "after insert or update of payment_status, customer_name, email, phone, amount_sgd on public.orders",
  "new.payment_status <> 'paid'",
  "pg_advisory_xact_lock(hashtextextended('qy_roam_customer:' || v_identity, 0))",
  "pg_advisory_xact_lock(hashtextextended('qy_roam_customer:' || v_old_identity, 0))",
  'foreach v_previous_customer_id in array v_previous_customer_ids loop',
  'perform public.qy_reconcile_customer_paid_totals(v_customer_id)',
  "'customer', 'checkout'",
  'customers_normalized_email_idx',
  'customers_normalized_phone_idx',
  'create table if not exists public.crm_activities',
  'create table if not exists public.sales_opportunities',
  'create table if not exists public.forecasts',
  'create table if not exists public.closing_periods',
  'create or replace function public.qy_record_closing_period',
  "pg_advisory_xact_lock(hashtextextended('qy_roam_closing_period:' || p_period_start::text || ':' || p_period_end::text, 0))",
  'closed accounting period cannot be replaced',
  'grant execute on function public.qy_record_closing_period(date,date,boolean,numeric,numeric,numeric,numeric,numeric,numeric,text,text) to service_role',
  'create or replace view public.sales_daily_summary',
  'create or replace function public.qy_operations_schema_version',
  'grant execute on function public.qy_operations_schema_version() to service_role',
  'alter table public.inventory_items enable row level security',
  'alter table public.customers enable row level security',
  'grant execute on function public.qy_adjust_inventory(bigint,integer,text,text,text) to service_role',
  'return_disposition text',
  'digital_delivery_reference text',
  'orders_product_fulfilment_status_check',
  'orders_fulfilment_requires_paid_payment_check',
  "coalesce(payment_status = 'paid', false)",
  'orders_payment_confirmed_at_requires_paid_payment_check',
  "product_type = 'pocket_wifi' and fulfilment_status in",
  "product_type = 'esim' and fulfilment_status in",
  'create or replace function public.qy_enforce_esim_fulfilment_transition',
  'create trigger qy_enforce_esim_fulfilment_transition',
  'invalid eSIM fulfilment transition',
  'new eSIM order must begin before digital fulfilment',
  'order product type is immutable',
  "before insert or update of product_type, fulfilment_status on public.orders",
  ') not valid;',
  "return_quarantined', 'return_damaged",
  'inventory_movements_type_check',
  'inventory_movements_reference_check',
  'create trigger qy_enforce_inventory_custody_movement_once',
  'Pocket WiFi dispatch movement already exists for this order and inventory item',
  'Pocket WiFi return movement already exists for this order and inventory item',
  "not in ('adjustment', 'purchase', 'write_off')",
  'p_return_disposition text',
  'Require an explicit',
  'grant execute on function public.qy_transition_pocket_wifi_order(bigint,text,timestamptz,text,text,text,text,bigint,text) to service_role',
  'grant execute on function public.qy_create_manual_pocket_wifi_order(text,text,text,text,numeric,text,text,date,date,text,integer) to service_role',
  'grant execute on function public.qy_create_inventory_item(text,text,text,text,text,integer,integer,numeric,text,text) to service_role',
];

for (const contract of requiredContracts) {
  assert.ok(schema.includes(contract), `Missing operations schema contract: ${contract}`);
}

// This file is also the clean-install migration. Keep database objects ahead
// of functions that resolve their tables/columns; testing only for presence
// allowed a schema that upgraded successfully but failed on an empty project.
const inventoryTable = schema.indexOf('create table if not exists public.inventory_items');
const orderInventoryColumn = schema.indexOf('alter table public.orders add column if not exists inventory_item_id');
const reservationFunction = schema.indexOf('create or replace function public.qy_reserve_pocket_wifi');
const manualOrderFunction = schema.indexOf('create or replace function public.qy_create_manual_pocket_wifi_order');
const pocketWifiPersistenceFunction = schema.indexOf('create or replace function public.qy_persist_stripe_pocket_wifi_order');
const integritySchemaVersion = schema.indexOf('create or replace function public.qy_order_integrity_schema_version');
const operationsSchemaVersion = schema.indexOf('create or replace function public.qy_operations_schema_version');
const closingFunction = schema.indexOf('create or replace function public.qy_record_closing_period');
const salesSummaryView = schema.indexOf('create or replace view public.sales_daily_summary');
assert.ok(inventoryTable >= 0 && inventoryTable < reservationFunction, 'inventory_items must exist before the reservation function');
assert.ok(orderInventoryColumn > inventoryTable && orderInventoryColumn < reservationFunction, 'orders.inventory_item_id must exist before the reservation function');
assert.ok(inventoryTable < manualOrderFunction, 'inventory_items must exist before the manual-order function');
assert.ok(integritySchemaVersion > pocketWifiPersistenceFunction, 'order-integrity schema version must be written after every paid-order function it certifies');
assert.ok(
  operationsSchemaVersion > closingFunction && operationsSchemaVersion > salesSummaryView,
  'operations schema version must be written after every operations contract it certifies',
);
assert.match(
  schema.slice(operationsSchemaVersion),
  /as \$\$ select 2; \$\$/,
  'operations schema marker must advertise the reviewed version required by the application',
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Operations schema guard passed for ${requiredContracts.length} admin contracts, PL/pgSQL structure and terminators, table, index, trigger and constraint declarations, function parameters, conflict-update assignments, RETURNING clauses, and clean-install dependency order.`);
}
