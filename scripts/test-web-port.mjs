// CI may request an ephemeral port; local verification can reserve a bounded test port.
export function webTestPort(environment = process.env) {
  const value = environment.KIOKUKO_TEST_WEB_PORT;
  if (value === undefined) return '0';
  if (!/^[0-9]+$/.test(value) || Number(value) < 10001 || Number(value) > 65000) throw new Error('KIOKUKO_TEST_WEB_PORT must be between 10001 and 65000');
  return value;
}
