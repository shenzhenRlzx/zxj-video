const fs = require('fs');
const path = require('path');

// Helper to extract clean IPv4 from possible IPv6 mapped IPv4
function cleanIp(ip) {
  if (!ip) return '';
  const parts = ip.split(':');
  return parts[parts.length - 1];
}

module.exports = {
  cleanIp
};
