const nodemailer = require('nodemailer');
const db = require('./database');
const logger = require('./logger');
const { decrypt } = require('../utils/crypto');

let _cachedKey = '';
let _cachedTransporter = null;

function toBool(v, fallback = false) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function getConfig() {
  const cfg = {
    enabled: toBool(db.getSetting('smtp_enabled'), false),
    host: (db.getSetting('smtp_host') || '').trim(),
    port: parseInt(db.getSetting('smtp_port') || '587', 10) || 587,
    secure: toBool(db.getSetting('smtp_secure'), false),
    user: (db.getSetting('smtp_user') || '').trim(),
    pass: decrypt(db.getSetting('smtp_pass')) || '',
    fromName: (db.getSetting('smtp_from_name') || '大聪明').trim(),
    fromEmail: (db.getSetting('smtp_from_email') || '').trim(),
  };
  return cfg;
}

function buildCacheKey(cfg) {
  return [
    cfg.enabled ? '1' : '0',
    cfg.host,
    cfg.port,
    cfg.secure ? '1' : '0',
    cfg.user,
    cfg.pass,
  ].join('|');
}

function getTransporter() {
  const cfg = getConfig();
  if (!cfg.enabled) return null;
  if (!cfg.host || !cfg.user || !cfg.pass) return null;

  const key = buildCacheKey(cfg);
  if (_cachedTransporter && _cachedKey === key) return _cachedTransporter;

  if (_cachedTransporter) {
    _cachedTransporter.close();
  }
  _cachedKey = key;
  // 用发件域名作为 EHLO 标识，避免使用默认的机器 hostname（可能是 localhost）
  const fromDomain = (cfg.fromEmail || cfg.user || '').split('@')[1] || cfg.host;
  _cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    name: fromDomain,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
  return _cachedTransporter;
}

function resolveFrom(cfg) {
  const email = cfg.fromEmail || cfg.user;
  if (!email) return '';
  return cfg.fromName ? `${cfg.fromName} <${email}>` : email;
}

async function verifyConnection() {
  const cfg = getConfig();
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error('SMTP 未启用或配置不完整');
  }
  await transporter.verify();
  return { ok: true, from: resolveFrom(cfg) };
}

async function sendMail({ to, subject, text, html }) {
  const cfg = getConfig();
  const transporter = getTransporter();
  if (!transporter) {
    logger.debug('SMTP 未启用或配置不完整，跳过邮件发送');
    return { skipped: true };
  }
  const from = resolveFrom(cfg);
  if (!from) {
    throw new Error('SMTP 发件人未配置');
  }

  return transporter.sendMail({
    from,
    to,
    subject: String(subject || ''),
    text: String(text || ''),
    html: html ? String(html) : undefined,
  });
}

module.exports = {
  getConfig,
  verifyConnection,
  sendMail,
};
