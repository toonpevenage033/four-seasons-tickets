module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins || []),
    ['./plugins/withDevelopmentNetworking', { enabled: process.env.SCANNER_DEV_HTTP === '1' }],
  ],
});
