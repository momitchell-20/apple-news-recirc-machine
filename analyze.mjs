#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INPUT = '/Users/mmitchell/Downloads/Apple News+ Dwell Time - BI Top 50 By Month.csv';
const DEFAULT_OUTDIR = path.resolve('/Users/mmitchell/apple-news-republish-analyzer/output');

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    outdir: DEFAULT_OUTDIR,
    asOf: new Date().toISOString().slice(0, 10),
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      args.input = argv[++i];
    } else if (arg === '--outdir' && argv[i + 1]) {
      args.outdir = path.resolve(argv[++i]);
    } else if (arg === '--as-of' && argv[i + 1]) {
      args.asOf = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node analyze.mjs [--input path] [--outdir path] [--as-of YYYY-MM-DD]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else if (ch === '"') {
      quoted = true;
    } else {
      cur += ch;
    }
  }

  out.push(cur);
  return out;
}

function parseCsv(text) {
  const normalized = text.replace(/^\uFEFF/, '').trim();
  const lines = normalized.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = values[i] ?? '';
    }
    return row;
  });
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c] ?? '')).join(','));
  }
  return lines.join('\n');
}

function num(value) {
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDateLoose(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const candidates = [raw, raw.replace(' ', 'T')];
  for (const candidate of candidates) {
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value));
}

function monthsBetween(dateA, dateB) {
  return (dateB.getFullYear() - dateA.getFullYear()) * 12 + (dateB.getMonth() - dateA.getMonth());
}

function weeksBetween(dateA, dateB) {
  return (dateB.getTime() - dateA.getTime()) / (1000 * 60 * 60 * 24 * 7);
}

function getSeason(date) {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'fall';
  return 'winter';
}

function topicAndReasons(title) {
  const t = title.toLowerCase();
  const reasons = [];
  let score = 0;
  let category = 'other';
  const yearMatch = t.match(/\b(19|20)\d{2}\b/);
  const currentYear = new Date().getFullYear();

  const add = (n, label) => {
    score += n;
    if (label) reasons.push(label);
  };

  if (/\b(apple news|breaking|live updates|state of the union|election|protest|war in|ukraine|biden|trump|musk|stock market crash|earnings call|lawsuit|sentencing|obituary|death certificate)\b/.test(t)) {
    add(-35, 'newsy / event-driven');
  }
  if (yearMatch) {
    const titleYear = Number(yearMatch[0]);
    if (Number.isFinite(titleYear) && titleYear !== currentYear) {
      add(-30, 'year-specific / time-bound');
    }
  }

  if (/\b(food|restaurant|dining|recipe|cook|baker|baking|coffee|cake|pizza|cheesecake|chipotle|bread|trader joe|mcdonald|outback|texas roadhouse|breakfast|sandwich|burger|dessert)\b/.test(t)) {
    category = 'food';
    add(24, 'food');
  } else if (/\b(travel|trip|airport|flight|airlines|cruise|vacation|city|country|greece|spain|portugal|europe|amtrak|hotel|island|tourists?|road trip)\b/.test(t)) {
    category = 'travel';
    add(22, 'travel');
  } else if (/\b(home|house|apartment|room|decor|interior|kitchen|mansion|real[- ]estate|housing|mortgage|college town|school|college)\b/.test(t)) {
    category = 'home/real-estate';
    add(20, 'home / real estate');
  } else if (/^i tried|^i ate|^i bought|^i sold|^i used|^i made|^i make|^i went|^i take|^i work|^i'm|^i’ve|^i have/.test(t)) {
    category = 'first-person';
    add(18, 'first-person');
  } else if (/^the best|^the most|^the 25|^the 30|^the 35|^the 13|^the 20|^the top|^all \d+|^\d+ /.test(t)) {
    category = 'ranking/list';
    add(16, 'ranking / list');
  } else if (/\b(then and now|where are they now)\b/.test(t)) {
    category = 'nostalgia';
    add(15, 'nostalgia');
  } else if (/\b(how much|how to|how .* works|how .* makes|how .* earns|how .* saved|how .* invested|how .* grew|why .*|what .* )/.test(t)) {
    category = 'money/how-to';
    add(10, 'explain / how-to');
  } else if (/\b(celebr|actor|movie|tv|show|cast|stars|disney|harry potter|schitt|idol|kardashian|royal|prince|princess|sober celebrities)\b/.test(t)) {
    category = 'entertainment';
    add(12, 'entertainment');
  } else if (/\b(stock|market|invest|retire|retirement|salary|jobs?|career|zillow|ai|nvidia|amazon|google|apple|walmart|business|wall street)\b/.test(t)) {
    category = 'news/business';
    add(4, 'business / market');
  } else {
    add(4, 'general evergreen');
  }

  if (/\b(inside|take a look inside|take a look around|look inside|photos show|what it's really like|here's what it was like|here's what it's like)\b/.test(t)) {
    add(8, 'inside look');
  }
  if (/\b(compare|compared|comparison|differences|better than|worst to best|best and worst|ranked from worst to best)\b/.test(t)) {
    add(7, 'comparison');
  }
  if (/\b(evergreen|evergreen story)\b/.test(t)) {
    add(3, 'evergreen keyword');
  }

  return { category, reasons, score };
}

function seasonalBoost(title, season) {
  const t = title.toLowerCase();
  const reasons = [];
  let score = 0;

  const add = (n, label) => {
    score += n;
    if (label) reasons.push(label);
  };

  if (season === 'summer') {
    if (/\b(travel|vacation|beach|cruise|road trip|summer|outdoor|flight|airlines|hotel|island)\b/.test(t)) add(7, 'summer timing');
    if (/\b(food|bbq|ice cream|coffee|drink|restaurant)\b/.test(t)) add(3, 'summer food');
  } else if (season === 'fall') {
    if (/\b(back to school|college|dorm|home|organization|holiday|halloween|thanksgiving|cozy)\b/.test(t)) add(7, 'fall timing');
  } else if (season === 'winter') {
    if (/\b(new year|resolution|retirement|savings|holiday|gift|winter|ski|cozy|budget)\b/.test(t)) add(6, 'winter timing');
  } else if (season === 'spring') {
    if (/\b(spring cleaning|garden|travel|refresh|organization|home)\b/.test(t)) add(5, 'spring timing');
  }

  return { score, reasons };
}

function contentSubtopic(title, category) {
  const t = title.toLowerCase();
  if (category === 'travel') {
    if (/\b(cruise|ship|cabin|suite|river cruise|luxury cruise)\b/.test(t)) return 'travel-cruise';
    if (/\b(hotel|hotel stay|resort|island|forbidden island|beach|tourists?|destination|travel|trip|vacation)\b/.test(t)) return 'travel-destination';
    return 'travel-other';
  }
  if (category === 'food') {
    if (/\b(fast[- ]food|burger|cheeseburger|chicken tenders|chipotle|mcdonald|outback|texas roadhouse|ihop|cheesecake factory|trader joe)\b/.test(t)) return 'food-chain';
    if (/\b(recipe|baker|baking|breakfast|dessert|coffee|meal prep|diet|nutrition|healthy)\b/.test(t)) return 'food-daily-life';
    return 'food-other';
  }
  if (category === 'home/real-estate') {
    if (/\b(housing|home price|homebuyers|mortgage|house|apartment|real[- ]estate|rent|zillow)\b/.test(t)) return 'housing';
    if (/\b(college town|retire|move|relocate|relocation)\b/.test(t)) return 'housing-mobility';
    return 'home-design';
  }
  if (category === 'first-person') return 'personal-experiment';
  if (category === 'ranking/list') {
    if (/\b(retire|retirement|states|cities|best|worst)\b/.test(t)) return 'rankings-comparison';
    return 'rankings-list';
  }
  if (category === 'money/how-to') {
    if (/\b(job|career|salary|earn|income|work|jobs?|side hustle|freelance|resume|linkedin|boss)\b/.test(t)) return 'work-income';
    if (/\b(move|moving|relocate|relocation|retire|retirement)\b/.test(t)) return 'life-admin';
    return 'advice-how-to';
  }
  if (category === 'entertainment') return 'celebrity-entertainment';
  if (category === 'news/business') {
    if (/\b(ai|nvidia|google|apple|walmart|amazon|stock|market|business|wall street|startup)\b/.test(t)) return 'business-tech';
    return 'business-news';
  }
  if (/\b(retirement|social security|retiree|older americans|boomers|millennial)\b/.test(t)) return 'retirement';
  if (/\b(celebr|actor|movie|tv|show|cast|stars|disney|kardashian|royal|prince|princess)\b/.test(t)) return 'celebrity-entertainment';
  if (/\b(job|career|salary|earn|income|work|jobs?|side hustle|freelance|resume|linkedin|boss)\b/.test(t)) return 'work-income';
  if (/\b(ai|nvidia|google|apple|walmart|amazon|stock|market|business|wall street|startup)\b/.test(t)) return 'business-tech';
  return '';
}

function minuteBandScore(minutes) {
  if (minutes <= 0) return 0;
  if (minutes < 5000) return 1;
  if (minutes < 25000) return 4;
  if (minutes < 100000) return 9;
  if (minutes < 250000) return 14;
  if (minutes < 500000) return 11;
  if (minutes < 1000000) return 6;
  return -100;
}

function dedupeKey(row) {
  const raw = row.publisherArticleId || row.articleId || row.article;
  return String(raw || '').trim().split('?')[0];
}

function normalizeStoryKey(row) {
  const raw = row['Publisher Article ID'] || row.publisherArticleId || row.articleId || row.Article || '';
  return String(raw).trim().split('?')[0];
}

function buildDiverseShortlist(rows, limit = 10) {
  const caps = {
    travel: 3,
    food: 2,
    'home/real-estate': 2,
    'first-person': 2,
    'ranking/list': 2,
    entertainment: 1,
    'money/how-to': 1,
    other: 1,
    'news/business': 1,
    nostalgia: 1,
  };
  const priority = ['travel', 'food', 'home/real-estate', 'first-person', 'ranking/list', 'money/how-to', 'entertainment', 'other', 'news/business', 'nostalgia'];
  const counts = {};
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.category)) groups.set(row.category, []);
    groups.get(row.category).push(row);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.score - a.score || b.totalEngagedMinutes - a.totalEngagedMinutes);
  }

  const picked = [];
  const pickedKeys = new Set();
  let progressed = true;

  while (picked.length < limit && progressed) {
    progressed = false;
    for (const category of priority) {
      if (picked.length >= limit) break;
      const cap = caps[category] ?? 1;
      const used = counts[category] ?? 0;
      if (used >= cap) continue;
      const list = groups.get(category);
      if (!list || !list.length) continue;
      const next = list.shift();
      const key = dedupeKey(next);
      if (pickedKeys.has(key)) continue;
      picked.push(next);
      pickedKeys.add(key);
      counts[category] = used + 1;
      progressed = true;
    }
  }

  return picked.sort((a, b) => b.score - a.score || b.totalEngagedMinutes - a.totalEngagedMinutes);
}

function computeScore(story, asOfDate) {
  const title = story.article.trim();
  const published = parseDateLoose(story.firstPublished);
  const publishedLabel = story.firstPublished || '';
  const ageWeeks = published ? weeksBetween(published, asOfDate) : null;
  const season = getSeason(asOfDate);
  const { category, reasons: topicReasons, score: topicScore } = topicAndReasons(title);
  const subtopic = contentSubtopic(title, category);
  const seasonal = seasonalBoost(title, season);
  const mScore = minuteBandScore(story.totalEngagedMinutes);
  const exclusionThreshold = 500000;
  const minAgeWeeks = 8;
  const maxAgeWeeks = 104;
  const tooYoung = ageWeeks !== null && ageWeeks < minAgeWeeks;
  const tooOld = ageWeeks !== null && ageWeeks > maxAgeWeeks;
  const ageLabel = published ? `${publishedLabel} (${ageWeeks.toFixed(1)} weeks old)` : `${publishedLabel || 'unknown'} (unparseable)`;

  const hardExclude =
    story.totalEngagedMinutes > exclusionThreshold ||
    !published ||
    tooYoung ||
    tooOld ||
    (topicReasons.includes('newsy / event-driven') && mScore <= 0);
  const total = topicScore + seasonal.score + mScore + (hardExclude ? -1000 : 0);
  const reasons = [...topicReasons];
  if (subtopic) reasons.push(subtopic);
  reasons.push(...seasonal.reasons, `published ${ageLabel}`, `minutes band ${mScore}`);
  if (!published) reasons.push('unparseable first publish date');
  if (tooYoung) reasons.push('too new for re-up (needs ~2 months)');
  if (tooOld) reasons.push('older than 2 years');

  return {
    article: title,
    articleId: story.articleId,
    author: story.author,
    channel: story.channel,
    datePublished: story.firstPublished,
    monthOfPerformance: story.monthOfPerformance,
    publisherArticleId: story.publisherArticleId,
    subscriptionRequired: story.subscriptionRequired,
    totalEngagedMinutes: story.totalEngagedMinutes,
    category,
    subtopic,
    score: total,
    reasons: reasons.join(' | '),
    excluded: hardExclude ? 'yes' : 'no',
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const asOfDate = new Date(args.asOf);
  if (Number.isNaN(asOfDate.getTime())) {
    throw new Error(`Invalid --as-of date: ${args.asOf}`);
  }

  const inputText = await fs.readFile(args.input, 'utf8');
  const rows = parseCsv(inputText);
  const stories = new Map();
  for (const row of rows) {
    const key = normalizeStoryKey(row);
    const published = parseDateLoose(row['Date Published']);
    const existing = stories.get(key) || {
      article: row.Article || '',
      articleId: row['Article ID'] || '',
      author: row.Author || '',
      channel: row.Channel || '',
      firstPublished: row['Date Published'] || '',
      monthOfPerformance: row['Month of Performance'] || '',
      publisherArticleId: row['Publisher Article ID'] || row.publisherArticleId || row.articleId || '',
      subscriptionRequired: row['Subscription Required'] || '',
      totalEngagedMinutes: 0,
      rows: [],
    };
    if (!existing.firstPublished || (published && (!parseDateLoose(existing.firstPublished) || published < parseDateLoose(existing.firstPublished)))) {
      existing.firstPublished = row['Date Published'] || existing.firstPublished;
      existing.article = row.Article || existing.article;
      existing.articleId = row['Article ID'] || existing.articleId;
      existing.author = row.Author || existing.author;
      existing.channel = row.Channel || existing.channel;
      existing.monthOfPerformance = row['Month of Performance'] || existing.monthOfPerformance;
      existing.publisherArticleId = row['Publisher Article ID'] || row.publisherArticleId || row.articleId || existing.publisherArticleId;
      existing.subscriptionRequired = row['Subscription Required'] || existing.subscriptionRequired;
    }
    existing.totalEngagedMinutes += num(row['Total Engaged Minutes']);
    existing.rows.push(row);
    stories.set(key, existing);
  }
  const scored = [...stories.values()].map((story) => computeScore(story, asOfDate));

  const included = scored.filter((row) => row.excluded !== 'yes');
  const excluded = scored.filter((row) => row.excluded === 'yes');
  included.sort((a, b) => b.score - a.score || b.totalEngagedMinutes - a.totalEngagedMinutes);

  const uniqueMap = new Map();
  for (const row of included) {
    const key = dedupeKey(row);
    const existing = uniqueMap.get(key);
    if (!existing || row.score > existing.score || (row.score === existing.score && row.totalEngagedMinutes > existing.totalEngagedMinutes)) {
      uniqueMap.set(key, row);
    }
  }
  const uniqueIncluded = [...uniqueMap.values()].sort((a, b) => b.score - a.score || b.totalEngagedMinutes - a.totalEngagedMinutes);

  await fs.mkdir(args.outdir, { recursive: true });

  const columns = [
    'article',
    'articleId',
    'author',
    'channel',
    'datePublished',
    'monthOfPerformance',
    'publisherArticleId',
    'subscriptionRequired',
    'totalEngagedMinutes',
    'category',
    'subtopic',
    'score',
    'reasons',
    'excluded',
  ];

  await fs.writeFile(path.join(args.outdir, 'scored-stories.csv'), toCsv(included, columns), 'utf8');
  await fs.writeFile(path.join(args.outdir, 'excluded-stories.csv'), toCsv(excluded, columns), 'utf8');
  await fs.writeFile(path.join(args.outdir, 'unique-scored-stories.csv'), toCsv(uniqueIncluded, columns), 'utf8');

  const shortlist = buildDiverseShortlist(uniqueIncluded.filter((row) => row.score >= 30), 10);
  const summary = {
    source: args.input,
    asOf: args.asOf,
    totalRows: rows.length,
    included: included.length,
    uniqueIncluded: uniqueIncluded.length,
    excluded: excluded.length,
    thresholdExcluded: [...new Set(excluded.filter((row) => row.totalEngagedMinutes > 500000).map((row) => row.publisherArticleId || row.articleId || row.article))].length,
    shortlist,
    topCategories: Object.entries(
      included.reduce((acc, row) => {
        acc[row.category] = (acc[row.category] || 0) + 1;
        return acc;
      }, {})
    ).sort((a, b) => b[1] - a[1]),
  };

  await fs.writeFile(path.join(args.outdir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const reportLines = [
    '# Apple News BI Republish Scoring',
    '',
    `- Source rows: ${summary.totalRows}`,
    `- Included after hard filter: ${summary.included}`,
    `- Unique included after dedupe: ${summary.uniqueIncluded}`,
    `- Excluded: ${summary.excluded}`,
    `- Over 500k engaged minutes: ${summary.thresholdExcluded}`,
    '',
    '## Top shortlist',
    ...shortlist.map((row, i) => `${i + 1}. ${row.article} (${row.totalEngagedMinutes.toLocaleString()} engaged minutes, score ${row.score})`),
    '',
    '## Pattern notes',
    '- Use food, travel, home / real estate, and first-person comparison stories as the default republish pool.',
    '- Treat rankings / lists and inside-look visuals as secondary evergreen formats.',
    '- Penalize live-news, market-moving, and event-driven stories even when they perform well once.',
    '- Boost seasonal angles only when they also read as evergreen.',
  ];
  await fs.writeFile(path.join(args.outdir, 'report.md'), reportLines.join('\n'), 'utf8');

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
