import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSlackMessagePayload,
  chunkSlackBlocks,
  hasMarkdownStructure,
  markdownToSlackBlocks,
  toSlackMrkdwn,
  SLACK_BLOCKS_PER_MESSAGE,
} from '../src/slackBlocks';

const COMPETITOR_BRIEF = [
  '# Competitive Brief — Week of Jul 27',
  '',
  'Three moves matter this week.',
  '',
  '| Competitor | Move | Why it matters |',
  '| --- | --- | --- |',
  '| Acme Ops | Cut Pro tier to $59/mo | Undercuts the $79 entry tier |',
  '| Relay AI | Launched Slack review gates | Direct overlap with the approval flow |',
  '',
  '## Next actions',
  '- Re-check pricing page positioning',
  '- Draft a comparison one-pager with [evidence](https://example.com/report)',
].join('\n');

test('toSlackMrkdwn converts markdown inline syntax to Slack mrkdwn', () => {
  assert.equal(toSlackMrkdwn('**bold** stays [linked](https://x.dev/a)'), '*bold* stays <https://x.dev/a|linked>');
  assert.equal(toSlackMrkdwn('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('markdownToSlackBlocks renders title, table rows, and bullets as blocks', () => {
  const blocks = markdownToSlackBlocks(COMPETITOR_BRIEF);

  assert.equal(blocks[0].type, 'header');
  assert.equal((blocks[0] as { text: { text: string } }).text.text, 'Competitive Brief — Week of Jul 27');

  const sectionTexts = blocks
    .filter((block): block is Extract<typeof blocks[number], { type: 'section' }> => block.type === 'section')
    .map((block) => block.text.text);

  const tableSection = sectionTexts.find((text) => text.includes('*Acme Ops*'));
  assert.ok(tableSection, 'table rows render as a section');
  assert.ok(tableSection!.includes('• *Acme Ops* — Cut Pro tier to $59/mo'));
  assert.ok(tableSection!.includes('_Why it matters: Undercuts the $79 entry tier_'));
  assert.ok(!tableSection!.includes('|'), 'no raw pipe characters survive');

  const bulletSection = sectionTexts.find((text) => text.includes('• Re-check pricing page positioning'));
  assert.ok(bulletSection, 'bullets render with Slack bullet glyphs');
  assert.ok(bulletSection!.includes('<https://example.com/report|evidence>'));
});

test('standalone markdown images become Slack image blocks', () => {
  const blocks = markdownToSlackBlocks('![MRR chart](https://cdn.example.com/mrr.png)');
  assert.deepEqual(blocks, [
    { type: 'image', image_url: 'https://cdn.example.com/mrr.png', alt_text: 'MRR chart' },
  ]);
});

test('buildSlackMessagePayload keeps plain conversational sends as text only', () => {
  const payload = buildSlackMessagePayload({ body: 'On it — will report back in an hour.' });
  assert.equal(payload.text, 'On it — will report back in an hour.');
  assert.equal(payload.blocks, undefined);
});

test('buildSlackMessagePayload builds blocks with subject header and branded footer', () => {
  const payload = buildSlackMessagePayload({ subject: 'Automation run: Competitor monitor', body: '- one finding\n- two findings' });
  assert.ok(payload.blocks);
  assert.equal(payload.blocks![0].type, 'header');
  const footer = payload.blocks![payload.blocks!.length - 1];
  assert.equal(footer.type, 'context');
  assert.match(JSON.stringify(footer), /violema\.com/);
  assert.equal(payload.text, 'Automation run: Competitor monitor\n\n- one finding\n- two findings');
});

test('buildSlackMessagePayload does not double-title when the body leads with a heading', () => {
  const payload = buildSlackMessagePayload({ subject: 'Automation run: Competitor monitor', body: COMPETITOR_BRIEF });
  assert.ok(payload.blocks);
  const headers = payload.blocks!.filter((block) => block.type === 'header');
  assert.equal(headers.length, 1, 'body H1 wins over the subject header');
});

test('hasMarkdownStructure detects briefs but not chat text', () => {
  assert.ok(hasMarkdownStructure(COMPETITOR_BRIEF));
  assert.ok(!hasMarkdownStructure('Sounds good, shipping it now.'));
});

test('chunkSlackBlocks splits long briefs into threaded parts with continuation markers', () => {
  const blocks = markdownToSlackBlocks(
    ['# Long brief', ...Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\ncontent ${i}`)].join('\n\n'),
  );
  const chunks = chunkSlackBlocks(blocks);
  assert.ok(chunks.length >= 2, 'long brief splits into multiple messages');
  assert.ok(chunks.every((chunk) => chunk.length <= SLACK_BLOCKS_PER_MESSAGE + 1));
  assert.equal(chunks[0][0].type, 'header');
  assert.match(JSON.stringify(chunks[1][0]), /continued \(part 2\)/);
  assert.deepEqual(chunkSlackBlocks(blocks.slice(0, 10)), [blocks.slice(0, 10)], 'short briefs stay one message');
});

test('runaway briefs preserve every section across threaded chunks', () => {
  const huge = Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\ncontent ${i}`).join('\n\n');
  const blocks = markdownToSlackBlocks(huge);
  const rendered = JSON.stringify(blocks);
  assert.match(rendered, /Section 0/);
  assert.match(rendered, /Section 119/);
  assert.doesNotMatch(rendered, /Brief truncated/);
});

test('oversized paragraphs are split into complete Slack sections without dropping the tail', () => {
  const tail = 'TAIL_PARAGRAPH_EVIDENCE';
  const markdown = `## Evidence\n\n${'fact '.repeat(900)}${tail}`;
  const blocks = markdownToSlackBlocks(markdown);
  const sections = blocks.filter(
    (block): block is Extract<typeof block, { type: 'section' }> => block.type === 'section',
  );

  assert.ok(sections.length > 2, 'the paragraph is split instead of sliced');
  assert.ok(sections.every((block) => block.text.text.length <= 2900));
  assert.match(sections.map((block) => block.text.text).join(''), new RegExp(tail));
});

test('oversized rendered tables preserve their final row across multiple Slack sections', () => {
  const rows = Array.from(
    { length: 100 },
    (_, index) => `| Company ${index} | ${'detail '.repeat(12)} |`,
  );
  const markdown = ['| Company | Evidence |', '| --- | --- |', ...rows].join('\n');
  const blocks = markdownToSlackBlocks(markdown);
  const rendered = blocks
    .filter((block): block is Extract<typeof block, { type: 'section' }> => block.type === 'section')
    .map((block) => block.text.text)
    .join('\n');

  assert.match(rendered, /Company 0/);
  assert.match(rendered, /Company 99/);
});
