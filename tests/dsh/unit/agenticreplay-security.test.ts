import assert from 'node:assert/strict'
import test from 'node:test'
import { projectAgenticReplayJson, scrubAgenticReplayText as scrub } from '../../../src/dsh/agenticreplay-security.js'
import { boundedAgenticReplayPayload } from '../../../src/dsh/agenticreplay-event-mapper.js'
import { S, secretCases, benignCases } from '../helpers/agenticreplay-redaction-cases.js'

for (const [name, input, needle] of secretCases) test(`credential value removed: ${name}`, () => {
  const output = scrub(input)
  assert.ok(!output.includes(needle), output)
  assert.equal(scrub(output), output)
})
for (const input of benignCases) test(`benign text preserved: ${input}`, () => assert.equal(scrub(input), input))
const exactCases = [
  ['{"https://example.invalid/?token=FAKE":"ordinary"}', '{"https://example.invalid/?token=[REDACTED]":"ordinary"}'],
  ["'postgres://user:FAKE@localhost/test': 'ordinary'", "'postgres://user:[REDACTED]@localhost/test': 'ordinary'"],
  [String.raw`{\"https://example.invalid/?token=FAKE\":\"ordinary\"}`, String.raw`{\"https://example.invalid/?token=[REDACTED]\":\"ordinary\"}`],
  [String.raw`{\"url\":\"https://example.invalid/?token=FAKE\"}`, String.raw`{\"url\":\"https://example.invalid/?token=[REDACTED]\"}`],
  [String.raw`{\"url\":\"postgres://user:FAKE@localhost/path\"}`, String.raw`{\"url\":\"postgres://user:[REDACTED]@localhost/path\"}`],
  ['PASSWORD=FAKE,service_access_key_id=OTHER status=ok', 'PASSWORD=[REDACTED],service_access_key_id=[REDACTED] status=ok'],
  ['Bearer FAKEONLY_DUMMY_CREDENTIAL', 'Bearer [REDACTED]'],
  ['github_pat_FAKEONLY_DUMMY_CREDENTIAL xoxb-FAKEONLY_DUMMY_CREDENTIAL', '[REDACTED] [REDACTED]'],
  ['-----BEGIN RSA PRIVATE KEY-----\nFAKEONLY\n-----END RSA PRIVATE KEY-----\nstatus=ok', '[REDACTED]\nstatus=ok'],
  ['custom+scheme://user:FAKE%2FVALUE@localhost/p?access-token=OTHER&normal=yes#keep', 'custom+scheme://user:[REDACTED]@localhost/p?access-token=[REDACTED]&normal=yes#keep'],
  ['{"originalTask":"{\\"password\\":\\"FAKE\\"} status=ok"}', '{"originalTask":"{\\"password\\":\\"[REDACTED]\\"} status=ok"}'],
  ['{\\"password\\":\\"FAKE\\\\\\"VALUE\\"}', '{\\"password\\":\\"[REDACTED]\\"}'],
  [`API_KEY=${S} status=ok`, 'API_KEY=[REDACTED] status=ok'],
  [`{"password":"${S}","status":"ok"}`, '{"password":"[REDACTED]","status":"ok"}'],
  [`https://example.invalid/?token=${S}#keep`, 'https://example.invalid/?token=[REDACTED]#keep'],
  [`postgres://fakeuser:${S}@localhost/test`, 'postgres://fakeuser:[REDACTED]@localhost/test'],
  [`Authorization: Bearer ${S}`, 'Authorization: [REDACTED]'],
  [`log Authorization: Bearer ${S}`, 'log Authorization: [REDACTED]'],
  [`Authorization=Bearer ${S}`, 'Authorization=[REDACTED]'],
  [`serviceAuthorization=Bearer ${S}`, 'serviceAuthorization=[REDACTED]'],
  [`{"Authorization":"Bearer ${S}","status":"ok"}`, '{"Authorization":"[REDACTED]","status":"ok"}'],
  [`Cookie: first=${S}; second=PRIVATE\nstatus=ok`, 'Cookie: [REDACTED]\nstatus=ok'],
  [` Set-Cookie: first=${S}; HttpOnly\r\nstatus=ok`, ' Set-Cookie: [REDACTED]\r\nstatus=ok'],
  [`API key=${S} status=ok`, 'API key=[REDACTED] status=ok'],
  [`access token=${S} status=ok`, 'access token=[REDACTED] status=ok'],
  ["export OPENAI_API_KEY = 'FAKE VALUE' status=ok", "export OPENAI_API_KEY = '[REDACTED]' status=ok"],
  ['password="FAKE\\\"VALUE" status=ok', 'password="[REDACTED]" status=ok'],
  ['password="FAKE\\\\VALUE" status=ok', 'password="[REDACTED]" status=ok'],
  ['password="unfinished\n日本語🙂 status=ok', 'password="[REDACTED]\n日本語🙂 status=ok'],
  ["password='' token=\nstatus=ok", "password='[REDACTED]' token=[REDACTED]\nstatus=ok"],
  ['"https://example.invalid/p?token=FAKE%2FVALUE&token_count=3#keep"', '"https://example.invalid/p?token=[REDACTED]&token_count=3#keep"'],
  ['日本語🙂 AppApiKey=FAKE; MY_ACCESS_TOKEN=OTHER status=ok', '日本語🙂 AppApiKey=[REDACTED]; MY_ACCESS_TOKEN=[REDACTED] status=ok'],
  ['"MY API key":"FAKE", MY_access token=OTHER', '"MY API key":"[REDACTED]", MY_access token=[REDACTED]'],
  ['https://example.invalid/authorization:public?password=FAKE&secret=OTHER#keep', 'https://example.invalid/authorization:public?password=[REDACTED]&secret=[REDACTED]#keep'],
] as const
for (const [input, expected] of exactCases) test(`value boundaries: ${input}`, () => {
  assert.equal(scrub(input), expected); assert.equal(scrub(expected), expected)
})
for (const count of [1, 2]) test(`embedded JSON preserves delimiters after ${count} trailing backslashes`, () => {
  const input = JSON.stringify(JSON.stringify({password:S+'\\'.repeat(count),status:'ok'}))
  const expected = JSON.stringify(JSON.stringify({password:'[REDACTED]',status:'ok'}))
  assert.equal(scrub(input), expected)
  assert.equal(scrub(expected), expected)
})
test('structured exclusion preserves existing defenses and adds prefixed access key IDs', () => {
  const input = { password:S, api_key:S, accessToken:S, AWS_ACCESS_KEY_ID:S, nested:{key:'lookup-index'} }
  assert.deepEqual(projectAgenticReplayJson(input, 10000), {nested:{key:'lookup-index'}})
  assert.equal(input.password, S)
  let accessed = false
  assert.deepEqual(projectAgenticReplayJson({get visible(){accessed=true;return S}},1000), {})
  assert.equal(accessed, false)
  assert.equal(projectAgenticReplayJson(new Date(),1000), '[runtime object omitted]')
  const cyclic:any={}; cyclic.child=cyclic
  assert.throws(()=>projectAgenticReplayJson(cyclic,10000),/projection_cycle/)
  let deep:any={}; for(let i=0;i<34;i++)deep={child:deep}
  assert.throws(()=>projectAgenticReplayJson(deep,100000),/projection_depth/)
  assert.deepEqual(projectAgenticReplayJson(JSON.parse('{"__proto__":{"x":1},"constructor":"x","key":"safe"}'),1000),{key:'safe'})
})
test('bounded hostile text completes; input budget remains charged before redaction', () => {
  for(const input of ['z'.repeat(100000), 'password="'+'\\'.repeat(100000), ':=;'.repeat(30000)]) assert.equal(scrub(scrub(input)),scrub(input))
  assert.throws(()=>projectAgenticReplayJson(`password=${S}`,16),/queue_limit/)
  assert.deepEqual(boundedAgenticReplayPayload({text:`password=${S}`},16,'fixture'),{payload:{format:'fixture',content_omitted:true,omission_reason:'payload_limit'},omitted:true,omissionReason:'payload_limit'})
})
