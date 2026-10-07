const DEFAULT_REALITY_SNI = 'www.bing.com';

// Keep an existing node's target stable when the deployment default changes.
function getRealitySni(nodeSni) {
  return nodeSni || process.env.REALITY_SNI?.trim() || DEFAULT_REALITY_SNI;
}

module.exports = { DEFAULT_REALITY_SNI, getRealitySni };
