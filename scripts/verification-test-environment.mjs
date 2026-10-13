// Negative fixtures started inside a test must not contribute evidence to its parent suite.
// The CLI test runner/reporters retain the directory; isolated test workers do not.
if (process.env.NODE_TEST_CONTEXT) delete process.env.KIOKUKO_VERIFY_REPORT_DIR;
