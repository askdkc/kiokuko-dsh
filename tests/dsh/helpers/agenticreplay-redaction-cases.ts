export const S = 'FAKEONLY_DUMMY_CREDENTIAL'
export const secretCases = [
  ['aws-short', 'AWS_ACCESS_KEY_ID=AKIAEXAMPLETEST1234', 'AKIAEXAMPLETEST1234'],
  ['aws-canonical', 'AWS_ACCESS_KEY_ID=AKIAFAKEONLY12345678', 'AKIAFAKEONLY12345678'],
  ['api', `API_KEY=${S}`, S], ['openai-env', `OPENAI_API_KEY=${S}`, S],
  ['aws-secret-env', `AWS_SECRET_ACCESS_KEY=${S}`, S],
  ['json-password', `{"password":"${S}"}`, S], ['json-api-key', `{"api_key":"${S}"}`, S],
  ['single-quote', `'password': '${S}'`, S], ['access-token', `accessToken=${S}`, S],
  ['database-uri', `postgres://fakeuser:${S}@localhost/test`, S],
  ['query-token', `https://example.invalid/?token=${S}`, S],
  ['bearer', `Authorization: Bearer ${S}`, S],
  ['sk-prefix', `sk-${S}`, `sk-${S}`], ['ghp-prefix', `ghp_${S}`, `ghp_${S}`],
] as const
export const benignCases = [
  'keyboard=mechanical', 'key=lookup-index', 'key_id=user-record-12',
  'api_key_count=12', 'token_budget=4096', 'password_policy=strict',
  'secretariat=office', 'AWS_ACCESS_KEY_ID is an environment variable name',
  '{"keyboard":"mechanical","key":"lookup-index","token_budget":4096}',
  'https://example.invalid/path?token_count=3&key_id=record-12',
  'The API key is described here.', 'my_secret_key_name=public-label',
] as const
