// El `import()` dinámico del exportador OTLP (@opentelemetry/otlp-exporter-base) no funciona dentro
// de Jest sin --experimental-vm-modules: test/utils/transformar-a-commonjs.js lo pasa a require.
// Es solo de las pruebas; en Node real no hace falta.
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/.*\\.spec\\.ts$',
  transform: {
    '/node_modules/@opentelemetry/otlp-exporter-base/.+\\.js$':
      '<rootDir>/test/utils/transformar-a-commonjs.js',
    '^.+\\.ts$': 'ts-jest',
  },
  transformIgnorePatterns: ['/node_modules/(?!(@opentelemetry/otlp-exporter-base)/)'],
  testEnvironment: 'node',
  // Cada archivo levanta sus propios servidores falsos; un plazo holgado para CI
  testTimeout: 30000,
};
