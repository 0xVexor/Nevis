// Formula language (handoff §15): every public function name has positive / boundary / error tests; F12-F18 vectors;
// lazy evaluation, scopes, budgets, cancellation, rename binding, dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'

const F = await import('../../../spike/tiptap/src/database/formula/index.ts')

const NOW = Date.parse('2026-10-25T08:00:00Z')
const ZONE = 'Asia/Tehran'

/** props: { Name: { id, type, value } } */
function env(props = {}, extra = {}) {
  const byId = new Map(Object.values(props).map((p) => [p.id, p]))
  return {
    vaultId: 'v', nowMs: NOW, zone: ZONE, currentPageId: 'T1',
    getProp: (_page, id) => {
      const p = byId.get(id)
      if (p.blocked) throw new F.Blocked(p.blocked)
      return p.value
    },
    findProp: () => undefined,
    pageTitle: (id) => ({ P1: 'Alpha', P2: 'Beta' })[id],
    person: (id) => ({ U1: { name: 'Ali', email: 'ali@example.com' }, U2: { name: 'Sara', email: null } })[id],
    ...extra,
  }
}
const schemaOf = (props) => ({ props: Object.entries(props).map(([name, p]) => ({ id: p.id, name, type: p.type })) })

function run(src, props = {}, extra = {}) {
  const c = F.compileFormula(src, schemaOf(props))
  if (!c.ok) return { compile: c.diagnostics }
  return F.evaluate(c.ast, env(props, extra))
}
const val = (src, props, extra) => {
  const r = run(src, props, extra)
  assert.equal(r.state, 'ready', `${src} -> ${JSON.stringify(r)}`)
  return r.value
}
const js = (v) => {
  switch (v.kind) {
    case 'empty': return null
    case 'number': case 'boolean': return v.value
    case 'text': return v.runs.map((r) => r.text).join('')
    case 'date': return v.value.end ? `${v.value.start}..${v.value.end}` : v.value.start
    case 'page': return `page:${v.id}`
    case 'person': return `person:${v.id}`
    case 'list': return v.items.map(js)
  }
}
const ev = (src, props, extra) => js(val(src, props, extra))
const errCode = (src, props, extra) => {
  const r = run(src, props, extra)
  if (r.compile) return r.compile[0].code
  assert.equal(r.state, 'error', `${src} should error, got ${JSON.stringify(r)}`)
  return r.diagnostics[0].code
}

const num = (v) => ({ kind: 'number', value: v })
const txt = (s) => ({ kind: 'text', runs: s ? [{ text: s }] : [] })
const costP = { Cost: { id: 'pCost', type: 'number', value: num(0) } }

test('F12 empty(): 0 and false are empty, whitespace text is not', () => {
  assert.equal(ev('empty(0)'), true)
  assert.equal(ev('empty(false)'), true)
  assert.equal(ev('empty("   ")'), false)
  assert.equal(ev('empty("")'), true)
  assert.equal(ev('empty([])'), true)
  assert.equal(ev('empty()'), true)
  assert.equal(ev('empty(1)'), false)
})

test('F13 if is lazy: the untaken branch is never evaluated', () => {
  assert.equal(ev('if(false, 1/0, 7)'), 7)
  assert.equal(ev('true ? 1 : 1/0'), 1)
  assert.equal(ev('ifs(false, 1/0, true, 2, 3)'), 2)
  assert.equal(ev('ifs(false, 1, 9)'), 9)
  assert.equal(ev('ifs(false, 1)'), null)
})

test('F14 map with current and index', () => {
  assert.deepEqual(ev('[1,2,3].map(current+index)'), [1, 3, 5])
  assert.deepEqual(ev('map([1,2,3], current * 2)'), [2, 4, 6])
})

test('F15 let / lets bind lexically', () => {
  assert.equal(ev('let(x,2,lets(y,x+3,y*2))'), 10)
  assert.equal(errCode('let(x, 1, y)'), 'FORMULA_NAME')
  assert.equal(errCode('let(1, 1, 2)'), 'FORMULA_SYNTAX')
})

test('F16 dateBetween in days', () => {
  assert.equal(ev('dateBetween(parseDate("2026-10-28"),parseDate("2026-10-25"),"days")'), 3)
  assert.equal(ev('dateBetween(parseDate("2026-10-25"),parseDate("2026-10-28"),"days")'), -3)
})

test('F17 prop() binds to the property id; rename keeps the binding and result', () => {
  assert.equal(ev('prop("Cost")+2', costP), 2)
  const c = F.compileFormula('prop("Cost")+2', schemaOf(costP))
  const renamed = F.renameInFormula(c.source, c.ast, 'pCost', 'Budget')
  assert.equal(renamed.source, 'prop("Budget")+2')
  const r = F.evaluate(renamed.ast, env({ Budget: { id: 'pCost', type: 'number', value: num(0) } }))
  assert.equal(r.state, 'ready')
  assert.equal(js(r.value), 2)
  // the OLD ast still evaluates after the property is renamed, because the binding is the id
  assert.equal(F.evaluate(c.ast, env({ Budget: { id: 'pCost', type: 'number', value: num(5) } })).value.value, 7)
})

test('F18 division by zero is a domain error, never 0 or Infinity', () => {
  const r = run('1/0')
  assert.equal(r.state, 'error')
  assert.equal(r.diagnostics[0].code, 'FORMULA_DOMAIN')
  assert.equal(errCode('mod(5, 0)'), 'FORMULA_DOMAIN')
  assert.equal(errCode('divide(1, 0)'), 'FORMULA_DOMAIN')
})

test('operators and precedence', () => {
  assert.equal(ev('1 + 2 * 3'), 7)
  assert.equal(ev('(1 + 2) * 3'), 9)
  assert.equal(ev('2 ^ 3 ^ 2'), 512) // right associative
  assert.equal(ev('-2 ^ 2'), -4) // exponent binds tighter than unary minus
  assert.equal(ev('2 ^ -1'), 0.5)
  assert.equal(ev('10 % 4'), 2)
  assert.equal(ev('1 < 2 and 3 > 2'), true)
  assert.equal(ev('1 < 2 && 3 < 2 || true'), true)
  assert.equal(ev('!false'), true)
  assert.equal(ev('not true'), false)
  assert.equal(ev('1 == 1'), true)
  assert.equal(ev('1 === 1'), true)
  assert.equal(ev('1 !== 2'), true)
  assert.equal(ev('"a" + "b"'), 'ab')
  assert.equal(errCode('"a" + 1'), 'FORMULA_TYPE')
  assert.equal(errCode('1 + "a"'), 'FORMULA_TYPE')
  assert.equal(ev('"b" > "a"'), true)
  assert.equal(errCode('1 < "a"'), 'FORMULA_TYPE')
  assert.equal(ev('true ? 1 : 2'), 1)
  assert.equal(ev('false ? 1 : true ? 2 : 3'), 2)
})

test('string literals: escapes, unicode, no interpolation', () => {
  assert.equal(ev('"a\\nb"'), 'a\nb')
  assert.equal(ev('"say \\"hi\\""'), 'say "hi"')
  assert.equal(ev("'single'"), 'single')
  assert.equal(ev('"\\u0041\\u{1F600}"'), 'A😀')
  assert.equal(ev('"${1+1}"'), '${1+1}')
  assert.equal(errCode('"\\q"'), 'FORMULA_SYNTAX')
  assert.equal(errCode('"unterminated'), 'FORMULA_SYNTAX')
  assert.equal(ev('length("سلام")'), 4)
  assert.equal(ev('length("😀a")'), 2)
})

test('syntax errors carry a source span', () => {
  const c = F.compileFormula('1 +', { props: [] })
  assert.equal(c.ok, false)
  assert.equal(c.diagnostics[0].code, 'FORMULA_SYNTAX')
  assert.ok(c.diagnostics[0].from >= 0)
  assert.equal(errCode('1 + * 2'), 'FORMULA_SYNTAX')
  assert.equal(errCode(''), 'FORMULA_SYNTAX')
  assert.equal(errCode('(1'), 'FORMULA_SYNTAX')
  assert.equal(errCode('1 2'), 'FORMULA_SYNTAX')
  assert.equal(errCode('prop(1)'), 'FORMULA_SYNTAX')
  assert.equal(errCode('foo(1)'), 'FORMULA_NAME')
  assert.equal(errCode('if(true, 1)'), 'FORMULA_ARITY')
  assert.equal(errCode('prop("Nope")'), 'FORMULA_NAME')
  assert.equal(errCode('1 @ 2'), 'FORMULA_SYNTAX')
})

// ───── one block per public function: positive / boundary / error ─────

test('fn:prop / fn:id / fn:format', () => {
  assert.equal(ev('prop("Cost")', costP), 0)
  assert.equal(ev('id()'), 'T1')
  assert.equal(ev('format(1.5)'), '1.5')
  assert.equal(ev('format(1e21)'), '1000000000000000000000')
  assert.equal(ev('format(true)'), 'true')
  assert.equal(ev('format([1,2])'), '1, 2')
  assert.equal(ev('format(parseDate("2026-10-25"))'), '2026-10-25')
  assert.equal(ev('format(prop("P"))', { P: { id: 'pP', type: 'list<page@s2>', value: { kind: 'list', items: [{ kind: 'page', id: 'P1', vaultId: 'v' }, { kind: 'page', id: 'P2', vaultId: 'v' }] } } }), 'Alpha, Beta')
  assert.equal(ev('format(prop("Cost"))', { Cost: { id: 'pC', type: 'number', value: { kind: 'empty' } } }), '')
})

test('fn:if / fn:ifs / fn:and / fn:or / fn:not / fn:empty / fn:equal / fn:unequal', () => {
  assert.equal(ev('if(1 < 2, "y", "n")'), 'y')
  assert.equal(errCode('if(1, 2, 3)'), 'FORMULA_TYPE')
  assert.equal(ev('and(true, false)'), false)
  assert.equal(ev('or(false, true)'), true)
  assert.equal(ev('false and (1/0 > 1)'), false) // lazy
  assert.equal(ev('true or (1/0 > 1)'), true) // lazy
  assert.equal(errCode('and(1, true)'), 'FORMULA_TYPE')
  assert.equal(ev('not(false)'), true)
  assert.equal(ev('equal([1,2],[1,2])'), true)
  assert.equal(ev('equal(1,"1")'), false)
  assert.equal(ev('unequal(1,2)'), true)
  assert.equal(ev('equal(parseDate("2026-10-25"), parseDate("2026-10-25"))'), true)
})

test('fn:length / fn:substring / fn:slice / fn:contains / fn:includes', () => {
  assert.equal(ev('length([1,2,3])'), 3)
  assert.equal(ev('length("")'), 0)
  assert.equal(errCode('length(1)'), 'FORMULA_TYPE')
  assert.equal(ev('substring("hello", 1, 3)'), 'el')
  assert.equal(ev('substring("hello", -3)'), 'llo')
  assert.equal(ev('substring("hello", 2, 99)'), 'llo')
  assert.equal(ev('substring("hello", 4, 2)'), '')
  assert.equal(ev('substring("😀ab", 1)'), 'ab')
  assert.equal(errCode('substring("a", 1.5)'), 'FORMULA_DOMAIN')
  assert.deepEqual(ev('slice([1,2,3,4], 1, 3)'), [2, 3])
  assert.deepEqual(ev('slice([1,2,3,4], -2)'), [3, 4])
  assert.deepEqual(ev('slice([1,2,3], 5)'), [])
  assert.equal(ev('contains("hello", "ell")'), true)
  assert.equal(ev('contains("hello", "x")'), false)
  assert.equal(errCode('contains([1], 1)'), 'FORMULA_TYPE')
  assert.equal(ev('includes([1,2,3], 2)'), true)
  assert.equal(ev('includes([1,2,3], "2")'), false)
  assert.equal(ev('"hello".contains("h")'), true)
})

test('fn:test / fn:match / fn:replace / fn:replaceAll (bounded patterns)', () => {
  assert.equal(ev('test("abc123", "\\\\d+")'), true)
  assert.equal(ev('test("abc", "\\\\d")'), false)
  assert.deepEqual(ev('match("a1b22c333", "\\\\d+")'), ['1', '22', '333'])
  assert.deepEqual(ev('match("abc", "\\\\d")'), [])
  assert.equal(ev('replace("aaa", "a", "b")'), 'baa')
  assert.equal(ev('replaceAll("aaa", "a", "b")'), 'bbb')
  assert.equal(ev('replaceAll("سلام دنیا", "دنیا", "جهان")'), 'سلام جهان')
  assert.equal(errCode('test("a", "(a")'), 'FORMULA_REGEX')
  assert.equal(errCode('test("a", "(?<=a)b")'), 'FORMULA_REGEX')
  assert.equal(errCode('test("a", "(a)\\\\1")'), 'FORMULA_REGEX')
  assert.equal(errCode('test("aaaa", "(a+)+b")'), 'FORMULA_REGEX') // catastrophic shape rejected
  assert.equal(errCode(`test("a", "${'a'.repeat(501)}")`), 'FORMULA_REGEX')
})

test('fn:lower / fn:upper / fn:trim / fn:repeat / fn:split / fn:join', () => {
  assert.equal(ev('lower("ABC")'), 'abc')
  assert.equal(ev('upper("abc")'), 'ABC')
  assert.equal(ev('upper("straße")'), 'STRASSE')
  assert.equal(ev('trim("  hi  ")'), 'hi')
  assert.equal(ev('trim("   ")'), '')
  assert.equal(ev('repeat("ab", 3)'), 'ababab')
  assert.equal(ev('repeat("ab", 0)'), '')
  assert.equal(errCode('repeat("ab", -1)'), 'FORMULA_DOMAIN')
  assert.equal(errCode('repeat("ab", 1.5)'), 'FORMULA_DOMAIN')
  assert.equal(errCode('repeat("abcdefghij", 100000000)'), 'FORMULA_BUDGET')
  assert.deepEqual(ev('split("a,b,c", ",")'), ['a', 'b', 'c'])
  assert.deepEqual(ev('split("ab", "")'), ['a', 'b'])
  assert.equal(ev('join(["a","b"], "-")'), 'a-b')
  assert.equal(ev('join([1,2,3], ", ")'), '1, 2, 3')
  assert.equal(ev('join([], ",")'), '')
})

test('fn:link / fn:style / fn:unstyle keep styles as data and reject unsafe input', () => {
  const link = val('link("site", "https://example.com")')
  assert.equal(link.runs[0].href, 'https://example.com')
  assert.equal(errCode('link("x", "javascript:alert(1)")'), 'FORMULA_DOMAIN')
  const styled = val('style("hi", "bold", "red")')
  assert.equal(styled.runs[0].bold, true)
  assert.equal(styled.runs[0].color, 'red')
  assert.equal(errCode('style("hi", "blink")'), 'FORMULA_DOMAIN')
  const un = val('unstyle(style("hi", "bold", "italic"), "bold")')
  assert.equal(un.runs[0].bold, undefined)
  assert.equal(un.runs[0].italic, true)
  assert.equal(val('unstyle(style("hi", "bold"))').runs[0].bold, undefined)
})

test('fn:add / fn:subtract / fn:multiply / fn:divide / fn:mod / fn:pow', () => {
  assert.equal(ev('add(1, 2)'), 3)
  assert.equal(ev('subtract(5, 7)'), -2)
  assert.equal(ev('multiply(3, 4)'), 12)
  assert.equal(ev('divide(9, 3)'), 3)
  assert.equal(ev('mod(-7, 3)'), -1)
  assert.equal(ev('pow(2, 10)'), 1024)
  assert.equal(errCode('pow(-8, 0.5)'), 'FORMULA_DOMAIN')
  assert.equal(errCode('pow(10, 1000)'), 'FORMULA_DOMAIN')
  assert.equal(errCode('multiply("a", 2)'), 'FORMULA_TYPE')
  assert.equal(ev('add(prop("Cost"), 1)', { Cost: { id: 'pC', type: 'number', value: { kind: 'empty' } } }), null) // Empty propagates
})

test('fn:min / fn:max / fn:sum / fn:mean / fn:median', () => {
  assert.equal(ev('min(3, 1, 2)'), 1)
  assert.equal(ev('max([3, 1, 2])'), 3)
  assert.equal(ev('sum(1, [2, 3])'), 6)
  assert.equal(ev('sum([])'), 0)
  assert.equal(ev('mean([1, 2, 6])'), 3)
  assert.equal(ev('median([3, 1, 2])'), 2)
  assert.equal(ev('median([1, 2, 3, 4])'), 2.5)
  assert.equal(ev('min([])'), null)
  assert.equal(ev('mean([])'), null)
  assert.equal(ev('median([])'), null)
  assert.equal(errCode('sum("a")'), 'FORMULA_TYPE')
  assert.equal(errCode('max([1, "a"])'), 'FORMULA_TYPE')
})

test('fn:abs / fn:ceil / fn:floor / fn:sqrt / fn:cbrt / fn:exp / fn:ln / fn:log10 / fn:log2 / fn:sign / fn:pi / fn:e', () => {
  assert.equal(ev('abs(-3)'), 3)
  assert.equal(ev('ceil(1.2)'), 2)
  assert.equal(ev('floor(-1.2)'), -2)
  assert.equal(ev('sqrt(9)'), 3)
  assert.equal(errCode('sqrt(-1)'), 'FORMULA_DOMAIN')
  assert.equal(ev('cbrt(-27)'), -3)
  assert.equal(ev('exp(0)'), 1)
  assert.equal(errCode('exp(1000)'), 'FORMULA_DOMAIN')
  assert.equal(ev('ln(1)'), 0)
  assert.equal(errCode('ln(0)'), 'FORMULA_DOMAIN')
  assert.equal(ev('log10(1000)'), 3)
  assert.equal(errCode('log10(-1)'), 'FORMULA_DOMAIN')
  assert.equal(ev('log2(8)'), 3)
  assert.equal(ev('sign(-9)'), -1)
  assert.equal(ev('sign(0)'), 0)
  assert.equal(ev('pi()'), Math.PI)
  assert.equal(ev('e()'), Math.E)
})

test('fn:round: ties toward +infinity, decimal places, negatives', () => {
  assert.equal(ev('round(2.5)'), 3)
  assert.equal(ev('round(-2.5)'), -2)
  assert.equal(ev('round(0.5)'), 1)
  assert.equal(ev('round(-0.5)'), 0)
  assert.equal(ev('round(1.005, 2)'), 1.01) // shortest decimal, not binary noise
  assert.equal(ev('round(-1.005, 2)'), -1)
  assert.equal(ev('round(1234.5678, 2)'), 1234.57)
  assert.equal(ev('round(1250, -2)'), 1300)
  assert.equal(ev('round(-1250, -2)'), -1200)
  assert.equal(ev('round(1.4999999, 2)'), 1.5)
  assert.equal(ev('round(0.1 + 0.2, 1)'), 0.3)
  assert.equal(errCode('round(1, 13)'), 'FORMULA_DOMAIN')
  assert.equal(errCode('round(1, 0.5)'), 'FORMULA_DOMAIN')
  assert.equal(ev('round(1e-7, 3)'), 0)
})

test('fn:toNumber is strict', () => {
  assert.equal(ev('toNumber("12.5")'), 12.5)
  assert.equal(ev('toNumber("۱۲٫۵")'), 12.5) // Persian digits and the Arabic decimal separator
  assert.equal(ev('toNumber(true)'), 1)
  assert.equal(ev('toNumber(false)'), 0)
  assert.equal(ev('toNumber(5)'), 5)
  assert.equal(ev('toNumber(parseDate("1970-01-02"))'), Date.parse('1970-01-01T20:30:00Z')) // local midnight in Tehran
  assert.equal(errCode('toNumber("12abc")'), 'FORMULA_DOMAIN')
  assert.equal(errCode('toNumber("")'), 'FORMULA_DOMAIN')
  assert.equal(errCode('toNumber([1])'), 'FORMULA_TYPE')
  assert.equal(ev('toNumber(prop("Cost"))', { Cost: { id: 'pC', type: 'number', value: { kind: 'empty' } } }), null)
})

test('fn:now / fn:today use the injected clock and zone', () => {
  assert.equal(ev('today()'), '2026-10-25')
  assert.equal(val('now()').value.start, '2026-10-25T08:00:00.000Z')
  assert.equal(ev('today()', {}, { nowMs: Date.parse('2026-10-24T21:00:00Z') }), '2026-10-25') // 00:30 Tehran
  assert.equal(ev('today()', {}, { nowMs: Date.parse('2026-10-24T19:00:00Z') }), '2026-10-24') // 22:30 Tehran
})

test('fn:minute / fn:hour / fn:day / fn:date / fn:week / fn:month / fn:year', () => {
  const d = 'parseDate("2026-10-25T12:34:00+03:30")'
  assert.equal(ev(`minute(${d})`), 34)
  assert.equal(ev(`hour(${d})`), 12) // zone of the evaluation (Tehran): 09:04Z + 3:30
  assert.equal(ev('day(parseDate("2026-10-25"))'), 7) // Sunday
  assert.equal(ev('day(parseDate("2026-10-26"))'), 1) // Monday
  assert.equal(ev('date(parseDate("2026-10-25"))'), 25)
  assert.equal(ev('week(parseDate("2026-01-01"))'), 1)
  assert.equal(ev('week(parseDate("2027-01-01"))'), 53)
  assert.equal(ev('month(parseDate("2026-10-25"))'), 10)
  assert.equal(ev('year(parseDate("2026-10-25"))'), 2026)
  assert.equal(ev('hour(parseDate("2026-10-25"))'), 0)
  assert.equal(errCode('year(5)'), 'FORMULA_TYPE')
})

test('fn:dateAdd / fn:dateSubtract: calendar units clamp, intervals move together', () => {
  assert.equal(ev('dateAdd(parseDate("2026-01-31"), 1, "months")'), '2026-02-28')
  assert.equal(ev('dateAdd(parseDate("2028-01-31"), 1, "month")'), '2028-02-29')
  assert.equal(ev('dateAdd(parseDate("2026-10-25"), 2, "weeks")'), '2026-11-08')
  assert.equal(ev('dateAdd(parseDate("2026-10-25"), 1, "years")'), '2027-10-25')
  assert.equal(ev('dateAdd(parseDate("2026-10-25"), 1, "quarters")'), '2027-01-25')
  assert.equal(ev('dateSubtract(parseDate("2026-03-01"), 1, "days")'), '2026-02-28')
  assert.equal(ev('dateAdd(dateRange(parseDate("2026-10-25"), parseDate("2026-10-27")), 1, "days")'), '2026-10-26..2026-10-28')
  assert.equal(val('dateAdd(parseDate("2026-10-25T10:00:00Z"), 90, "minutes")').value.start, '2026-10-25T11:30:00.000Z')
  assert.equal(errCode('dateAdd(parseDate("2026-10-25"), 1, "hours")'), 'FORMULA_DOMAIN')
  assert.equal(errCode('dateAdd(parseDate("2026-10-25"), 1, "fortnights")'), 'FORMULA_DOMAIN')
  assert.equal(errCode('dateAdd(parseDate("2026-10-25"), 1.5, "days")'), 'FORMULA_DOMAIN')
  // wall-clock preserved across a DST change when adding days in a DST zone
  const ny = { zone: 'America/New_York' }
  assert.equal(val('dateAdd(parseDate("2026-03-07T09:00:00-05:00"), 1, "days")', {}, ny).value.start, '2026-03-08T13:00:00.000Z') // 09:00 EDT
})

test('fn:dateBetween: completed units truncated toward zero', () => {
  const b = (a, c, u) => ev(`dateBetween(parseDate("${a}"), parseDate("${c}"), "${u}")`)
  assert.equal(b('2026-10-25', '2026-01-31', 'months'), 8)
  assert.equal(b('2026-02-28', '2026-01-31', 'months'), 1) // anchored on Jan 31, +1 month clamps to Feb 28
  assert.equal(b('2026-02-27', '2026-01-31', 'months'), 0) // not a completed month yet
  assert.equal(b('2026-03-31', '2026-01-31', 'months'), 2)
  assert.equal(b('2026-01-31', '2026-03-31', 'months'), -2)
  assert.equal(b('2027-10-24', '2026-10-25', 'years'), 0)
  assert.equal(b('2027-10-25', '2026-10-25', 'years'), 1)
  assert.equal(b('2026-11-01', '2026-10-25', 'weeks'), 1)
  assert.equal(b('2026-10-31', '2026-10-25', 'weeks'), 0)
  assert.equal(b('2026-10-20', '2026-10-25', 'weeks'), 0) // truncates toward zero
  assert.equal(b('2026-10-10', '2026-10-25', 'weeks'), -2)
  assert.equal(b('2026-10-25T12:00:00Z', '2026-10-25T10:30:00Z', 'minutes'), 90)
  assert.equal(b('2026-10-25T12:00:00Z', '2026-10-25T10:30:00Z', 'hours'), 1)
  assert.equal(b('2026-10-25T12:00:00Z', '2026-10-25T10:30:00Z', 'seconds'), 5400)
  assert.equal(b('2026-04-30', '2026-01-31', 'quarters'), 1)
  assert.equal(errCode('dateBetween(1, 2, "days")'), 'FORMULA_TYPE')
})

test('fn:dateRange / fn:dateStart / fn:dateEnd / fn:timestamp / fn:fromTimestamp / fn:parseDate / fn:formatDate', () => {
  assert.equal(ev('dateRange(parseDate("2026-10-25"), parseDate("2026-10-28"))'), '2026-10-25..2026-10-28')
  assert.equal(ev('dateRange(parseDate("2026-10-25"), parseDate("2026-10-25"))'), '2026-10-25')
  assert.equal(errCode('dateRange(parseDate("2026-10-28"), parseDate("2026-10-25"))'), 'FORMULA_DOMAIN')
  assert.equal(errCode('dateRange(parseDate("2026-10-28"), parseDate("2026-10-29T10:00:00Z"))'), 'FORMULA_TYPE')
  const r = 'dateRange(parseDate("2026-10-25"), parseDate("2026-10-28"))'
  assert.equal(ev(`dateStart(${r})`), '2026-10-25')
  assert.equal(ev(`dateEnd(${r})`), '2026-10-28')
  assert.equal(ev('dateEnd(parseDate("2026-10-25"))'), '2026-10-25')
  assert.equal(ev('timestamp(parseDate("2026-10-25T08:00:00Z"))'), NOW)
  assert.equal(ev('timestamp(parseDate("1970-01-01"))'), Date.parse('1969-12-31T20:30:00Z')) // local midnight Tehran
  assert.equal(val('fromTimestamp(1761379245123)').value.start, '2025-10-25T08:00:00.000Z') // seconds / ms dropped
  assert.equal(val('parseDate("2026-10-25T12:00")').value.start, '2026-10-25T08:30:00.000Z') // evaluation zone
  assert.equal(errCode('parseDate("25/10/2026")'), 'FORMULA_DOMAIN')
  assert.equal(errCode('parseDate("2026-02-30")'), 'FORMULA_DOMAIN')
  const when = 'parseDate("2026-10-25T14:05:09+03:30")'
  assert.equal(ev(`formatDate(${when}, "YYYY-MM-DD HH:mm:ss")`), '2026-10-25 14:05:09')
  assert.equal(ev(`formatDate(${when}, "dddd, MMMM D, YYYY h:mm A")`), 'Sunday, October 25, 2026 2:05 PM')
  assert.equal(ev(`formatDate(${when}, "[Week] ddd Z")`), 'Week Sun +03:30')
  assert.equal(errCode(`formatDate(${when}, "YYYY Q")`), 'FORMULA_DOMAIN') // unsupported token, not guessed
  assert.equal(errCode(`formatDate(${when}, "[open")`), 'FORMULA_DOMAIN')
})

test('fn:formatNumber', () => {
  assert.equal(ev('formatNumber(1234567.891, "grouped", 2)'), '1,234,567.89')
  assert.equal(ev('formatNumber(0.256, "percent", 1)'), '25.6%')
  assert.equal(ev('formatNumber(1234.5, "USD")'), '$1,234.50')
  assert.equal(ev('formatNumber(1.5)'), '1.5')
  assert.equal(ev('formatNumber(2, "plain", 3)'), '2.000')
  assert.equal(errCode('formatNumber(1, "bogus")'), 'FORMULA_DOMAIN')
})

test('fn:name / fn:email are permission-aware', () => {
  const p = { Owner: { id: 'pO', type: 'person', value: { kind: 'person', id: 'U1' } }, Other: { id: 'pQ', type: 'person', value: { kind: 'person', id: 'U2' } } }
  assert.equal(ev('name(prop("Owner"))', p), 'Ali')
  assert.equal(ev('email(prop("Owner"))', p), 'ali@example.com')
  assert.equal(ev('email(prop("Other"))', p), null) // unavailable email -> Empty
  assert.equal(errCode('name("x")'), 'FORMULA_TYPE')
})

test('lists: fn:at / fn:first / fn:last / fn:concat / fn:reverse / fn:unique / fn:flat', () => {
  assert.equal(ev('at([1,2,3], 1)'), 2)
  assert.equal(ev('at([1,2,3], -1)'), 3)
  assert.equal(ev('at([1,2,3], 9)'), null)
  assert.equal(ev('first([5,6])'), 5)
  assert.equal(ev('last([5,6])'), 6)
  assert.equal(ev('first([])'), null)
  assert.deepEqual(ev('concat([1],[2,3],[])'), [1, 2, 3])
  assert.deepEqual(ev('reverse([1,2,3])'), [3, 2, 1])
  assert.deepEqual(ev('unique([1,2,1,3,2])'), [1, 2, 3])
  assert.deepEqual(ev('unique([1,"1"])'), [1, '1'])
  assert.deepEqual(ev('flat([[1,2],[3],4])'), [1, 2, 3, 4])
  assert.deepEqual(ev('flat([[[1]]])'), [[1]]) // one level only
  assert.equal(errCode('at(1, 1)'), 'FORMULA_TYPE')
  assert.equal(errCode('concat([1], 2)'), 'FORMULA_TYPE')
})

test('lists: fn:sort / fn:map / fn:filter / fn:find / fn:findIndex / fn:some / fn:every', () => {
  assert.deepEqual(ev('sort([3,1,2])'), [1, 2, 3])
  assert.deepEqual(ev('sort(["b","a"])'), ['a', 'b'])
  assert.deepEqual(ev('sort([1,2,3], -current)'), [3, 2, 1])
  assert.equal(errCode('sort([1,"a"])'), 'FORMULA_TYPE')
  assert.deepEqual(ev('filter([1,2,3,4], current % 2 == 0)'), [2, 4])
  assert.equal(ev('find([1,2,3], current > 1)'), 2)
  assert.equal(ev('find([1,2,3], current > 5)'), null)
  assert.equal(ev('findIndex([1,2,3], current > 1)'), 1)
  assert.equal(ev('findIndex([1,2,3], current > 5)'), -1)
  assert.equal(ev('some([], true)'), false)
  assert.equal(ev('every([], false)'), true)
  assert.equal(ev('some([1,2], current == 2)'), true)
  assert.equal(ev('every([1,2], current > 1)'), false)
  assert.equal(errCode('filter([1], current)'), 'FORMULA_TYPE')
  // nested lambdas get distinct scopes
  assert.deepEqual(ev('[1,2].map([10,20].map(current + index))'), [[10, 21], [10, 21]])
  assert.deepEqual(ev('map([1,2], let(x, current, map([10,20], current + x)))'), [[11, 21], [12, 22]])
})

test('fn:prop on a related page resolves by id and by runtime name', () => {
  const rel = { Project: { id: 'pProj', type: 'list<page@S2>', value: { kind: 'list', items: [{ kind: 'page', id: 'P1', vaultId: 'v' }, { kind: 'page', id: 'P2', vaultId: 'v' }] } } }
  const extra = {
    findProp: (_p, name) => (name === 'Budget' ? 'pBudget' : undefined),
    getProp: (page, id) => (id === 'pProj' ? rel.Project.value : id === 'pBudget' ? num(page === 'P1' ? 100 : 50) : (() => { throw new Error('?') })()),
  }
  const schema = { props: [{ id: 'pProj', name: 'Project', type: 'list<page@S2>' }], sourceProps: (s) => (s === 'S2' ? [{ id: 'pBudget', name: 'Budget', type: 'number' }] : []) }
  const c = F.compileFormula('sum(prop("Project").map(current.prop("Budget")))', schema)
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics))
  assert.deepEqual(c.deps.relatedPropertyIds, ['pBudget'])
  assert.equal(c.deps.dynamicRelated, false)
  const r = F.evaluate(c.ast, { ...env(rel), ...extra })
  assert.equal(js(r.value), 150)
  // without static info the name is resolved at runtime against the target page's source
  const dyn = F.compileFormula('sum(prop("Project").map(current.prop("Budget")))', { props: [{ id: 'pProj', name: 'Project', type: 'any' }] })
  assert.equal(dyn.ok, true)
  assert.equal(dyn.deps.dynamicRelated, true)
  assert.equal(js(F.evaluate(dyn.ast, { ...env(rel), ...extra }).value), 150)
  assert.equal(errCode('(1).prop("x")'), 'FORMULA_TYPE')
})

// ───── restricted / pending / budgets / dependencies ─────

test('blocked inputs give pending / restricted, never empty or zero', () => {
  const p = { Secret: { id: 'pS', type: 'number', value: num(1), blocked: 'restricted' } }
  assert.equal(run('prop("Secret") + 1', p).state, 'restricted')
  assert.equal(run('if(false, prop("Secret"), 3)', p).state, 'ready') // lazy: not touched
  const q = { Wait: { id: 'pW', type: 'number', value: num(1), blocked: 'pending' } }
  assert.equal(run('prop("Wait") * 2', q).state, 'pending')
})

test('budgets: steps, list size, text size, watchdog, cancellation', () => {
  // 40k-node parse limit is separate; here: a loop-ish expression via nested maps exceeds the step budget
  const big = Array.from({ length: 300 }, (_, i) => i).join(',')
  const src = `[${big}].map([${big}].map([${big}].map(current)))`
  const r = run(src)
  assert.equal(r.state, 'error')
  assert.equal(r.diagnostics[0].code, 'FORMULA_BUDGET')
  const many = F.compileFormula(`repeat("a", 600000)`, { props: [] })
  assert.equal(F.evaluate(many.ast, env()).diagnostics[0].code, 'FORMULA_BUDGET') // > 1 MB of UTF-16
  let t = 0
  const slow = F.evaluate(F.compileFormula(`[${big}].map([${big}].map(current))`, { props: [] }).ast, { ...env(), clock: () => (t += 50) })
  assert.equal(slow.diagnostics[0].code, 'FORMULA_BUDGET') // watchdog (fake clock jumps 50ms per check)
  const flag = { aborted: true }
  const cancelled = F.evaluate(F.compileFormula(`[${big}].map([${big}].map(current))`, { props: [] }).ast, env(), { signal: flag })
  assert.equal(cancelled.state, 'error')
  assert.equal(errCode(Array.from({ length: 10_050 }, () => '1').join('+')), 'FORMULA_BUDGET')
})

test('deps flag time-based refresh', () => {
  const a = F.compileFormula('dateBetween(now(), today(), "days")', { props: [] })
  assert.equal(a.deps.usesNow, true)
  assert.equal(a.deps.usesToday, true)
  const b = F.compileFormula('1+1', { props: [] })
  assert.equal(b.deps.usesNow, false)
})

test('registry: every public name is implemented, documented and tested', () => {
  const table = F.registryTable()
  const names = new Set(table.map((t) => t.name))
  for (const n of F.PUBLIC_NAMES) assert.ok(names.has(n), `missing function ${n}`)
  for (const t of table) {
    assert.ok(t.doc && t.doc.length >= 4, `${t.name} needs docs`)
    assert.ok(t.min >= 0 && (t.max === null || t.max >= t.min), `${t.name} arity`)
    assert.ok(t.tests.length > 0, `${t.name} needs test ids`)
  }
  assert.equal(F.PUBLIC_NAMES.length, 89)
})
