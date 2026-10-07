const AWS_QUERY_SERVICES = ['ec2', 'lightsail'];

function isValidQueryServices(value) {
  return Array.isArray(value) && value.length > 0 && value.every(service => AWS_QUERY_SERVICES.includes(service));
}

function getQueryServices(account) {
  try {
    const stored = JSON.parse(account.query_services || 'null');
    if (isValidQueryServices(stored)) return AWS_QUERY_SERVICES.filter(service => stored.includes(service));
  } catch (_) { /* 旧账号或损坏配置保留原来的双服务查询范围。 */ }
  return [...AWS_QUERY_SERVICES];
}

module.exports = { AWS_QUERY_SERVICES, isValidQueryServices, getQueryServices };
