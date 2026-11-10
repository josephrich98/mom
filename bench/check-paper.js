#!/usr/bin/env node
'use strict';
// Acceptance checker for bench/fixture-paper + bench/tasks-paper.json. Usage: node bench/check-paper.js <workdir>
const fs = require('fs'), path = require('path');
const work = path.resolve(process.argv[2] || '.');
let t = ''; try { t = fs.readFileSync(path.join(work, 'manuscript.md'), 'utf8'); } catch {}
const checks = {}, note = {};
const count = (re, s = t) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
const section = (name, next) => { const m = t.match(new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## ${next}|$(?![\\s\\S]))`, 'm')); return m ? m[1] : ''; };
const abs = section('Abstract', 'Introduction'), res = section('Results', 'Discussion'), disc = section('Discussion', 'Conclusions'), refs = (t.split(/^## References/m)[1] || '');
const body = t.split(/^## References/m)[0];
const words = s => s.trim().split(/\s+/).filter(Boolean).length;
// term (original has 13 occurrences across title, abstract, body, table, conclusions)
checks.term_old_gone = count(/intermittent drought/gi) === 0;
checks.term_new_count = count(/pulsed drought/gi) >= 11; // the abstract trim may legitimately merge some mentions
checks.term_title = /^# Pulsed drought/m.test(t);
checks.term_table = /\|\s*Pulsed drought\s*\|/.test(t);
// sample
checks.sample_old_412 = count(/\b412\b/) === 0;
checks.sample_old_206 = count(/\b206\b/) === 0;
checks.sample_old_389 = count(/\b389\b/) === 0;
checks.sample_new = count(/\b438\b/) >= 3 && count(/\b219\b/) >= 2 && count(/\b411\b/) >= 3;
// units
checks.units_old_gone = count(/g C m-2 yr-1/) === 0;
for (const [k, v] of [['182', '1.82'], ['141', '1.41'], ['57', '0.57'], ['96', '0.96'], ['230', '2.30']]) checks[`units_${k}`] = count(new RegExp(`${v.replace('.', '\\.')}\\s*Mg C ha-1 yr-1`)) >= 1 && count(new RegExp(`\\b${k} g C`)) === 0;
checks.units_table = /\|\s*1\.82 Mg C ha-1 yr-1\s*\|/.test(t) && /\|\s*2\.30 Mg C ha-1 yr-1\s*\|/.test(t);
// newresult
checks.new_results = /0\.42/.test(res) && /0\.31/.test(res) && /fungal/i.test(res);
checks.new_abstract = /fungal/i.test(abs);
checks.new_discussion = /fungal/i.test(disc) && /Okafor/.test(disc);
// citestyle
checks.cite_no_numeric_body = count(/\[\d+\]/g, body) === 0;
checks.cite_refs_no_numbers = count(/^\[\d+\]/gm, refs) === 0;
const authors = ['Ainsley', 'Brandt', 'Castellano', 'Delacroix', 'Eriksen', 'Farouk', 'Gupta', 'Hoffmann', 'Okafor', 'Quintero', 'Reinholt', 'Stavros'];
checks.cite_all_in_body = authors.every(a => new RegExp(`${a}[^)]{0,40}\\d{4}`).test(body));
const firsts = refs.trim().split('\n').filter(l => /\S/.test(l)).map(l => l.replace(/^\[\d+\]\s*/, '').split(' ')[0]);
checks.cite_refs_sorted = firsts.length === 12 && firsts.every((x, i) => !i || firsts[i - 1] <= x);
// abstract-limits
note.abstract_words = words(abs);
checks.abs_len = words(abs) <= 220 && words(abs) >= 80;
checks.abs_numbers = ['1.82|182', '1.41|141', '0.57|57', '0.96|96', '2.30|230'].every(n => new RegExp(n.split('|').map(x => x.replace('.', '\\.')).join('|')).test(abs));
checks.abs_lim_heading = /^### Limitations/m.test(disc);
const lim = (disc.split(/^### Limitations/m)[1] || '');
checks.abs_lim_content = /single site|one site/i.test(lim) && /three[- ]year|3[- ]year/i.test(lim) && /shelter/i.test(lim);
// sentinels: sentences no task should touch; losing one means collateral damage or a lost update
const S = {
  sent_fire: 'has been managed by prescribed fire on a three-year rotation for several decades',
  sent_fatty: 'phospholipid fatty acid profiles at the end of each growing season',
  sent_burrow: 'Field crews reported no change in the frequency of burrowing animals between treatments.',
  sent_frames: 'Shelter frames cast little shade because they remained retracted except during rainfall.',
  sent_sensors: 'Sensors in each plot logged volumetric water content at hourly intervals.',
  sent_q3: 'Third, does soil texture buffer these effects?',
  sent_climate: 'The timing of rainfall deserves equal standing with its total amount in projections of soil carbon.',
  sent_texture: 'Texture-dependent buffering offers a plausible mechanism for spatial variation in the response.'
};
for (const [k, v] of Object.entries(S)) checks[k] = t.includes(v);
checks.struct_sections = ['Abstract', 'Introduction', 'Methods', 'Results', 'Discussion', 'Conclusions', 'References'].every(h => new RegExp(`^## ${h}\\s*$`, 'm').test(t));
const score = Object.values(checks).filter(Boolean).length;
console.log(JSON.stringify({ score, max: Object.keys(checks).length, checks, note }));
