const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

module.exports = (config, { enabled = false } = {}) => {
  config = withAndroidManifest(config, result => {
    const application = result.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = enabled ? 'true' : 'false';
    return result;
  });
  return withInfoPlist(config, result => {
    result.modResults.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: enabled,
      NSAllowsLocalNetworking: enabled,
    };
    result.modResults.NSLocalNetworkUsageDescription = 'Connect to your development event backend and Metro server on the local network.';
    return result;
  });
};
