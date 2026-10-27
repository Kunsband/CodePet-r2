const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteText } = require('../provider-profile-store');

const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
class LiveHistory {
  constructor(home) { this.dir = path.join(home, 'live-history'); }
  file(id) { if (!validId(id)) throw new Error('대화 ID가 올바르지 않습니다.'); return path.join(this.dir, `${id}.json`); }
  read(id) {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  write(record) { fs.mkdirSync(this.dir, { recursive: true }); atomicWriteText(this.file(record.id), JSON.stringify(record)); }
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)).map(name => this.read(name.slice(0, -5))).filter(Boolean);
  }
}
module.exports = { LiveHistory, validId };
