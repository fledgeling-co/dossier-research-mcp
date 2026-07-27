/**
 * Test prose for the syndication detector, in one place because two test files
 * need the same pages and a fixture copied twice drifts.
 *
 * **Why this is real prose and not repeated filler.** A fixture built from
 * `'lorem '.repeat(200)` has a degenerate shingle set: a handful of distinct
 * ten-word windows, all of them shared with any other filler page. It would pass
 * a detector that does not work, and it would fail to distinguish the two cases
 * this whole item is accepted on. Both fixture families below are written as
 * ordinary news prose of ordinary length, about one event, which is the hardest
 * case for the detector rather than the easiest: four independent articles on
 * one story share their whole vocabulary and must still not be merged.
 *
 * Everything here is invented. It describes no real decision, quotes no real
 * person's real words, and is not a copy of anything published.
 */

/**
 * The wire copy. One agency story, as it would arrive at a subscribing outlet.
 */
const WIRE_BODY = [
  'The central bank left its cash rate unchanged at 3.85 per cent on Tuesday,',
  'holding steady for a third consecutive meeting as policymakers waited for clearer',
  'evidence that underlying inflation had settled inside the target band. In a statement',
  'accompanying the decision, the bank said trimmed mean inflation had eased to 2.7 per',
  'cent over the year to June, down from 2.9 per cent in the previous quarter, but that',
  'services prices remained firmer than the board would like. The governor told reporters',
  'the board had considered a reduction and judged that the case for waiting was stronger.',
  'Financial markets had priced roughly a one in three chance of a cut before the',
  'announcement. The local dollar rose about a quarter of a cent against the greenback in',
  'the minutes after the release, while three year bond yields climbed four basis points.',
  'Economists at three of the four major lenders now expect the first reduction in',
  'November, with one holding out for a move as early as September.',
  'The decision follows two quarters in which headline inflation fell faster than the bank',
  'had forecast, while the measure it watches most closely came down more slowly. Unemployment',
  'was steady at 4.1 per cent in the most recent labour force release, and job vacancies remain',
  'above their level before the pandemic. The board repeated that it would be guided by the data',
  'and by its assessment of the risks, a formulation it has used at every meeting this year.',
  'A further set of quarterly figures is due before the next decision, and several economists',
  'said that release would settle the argument one way or the other.',
].join(' ');

/**
 * Four printings of that one story.
 *
 * Each carries its own headline, its own standfirst and its own furniture, which
 * is what republication actually looks like: the body is the agency's and
 * everything around it is the outlet's. If the detector needed byte-identical
 * pages it would find nothing in the wild.
 */
export const WIRE_PRINTINGS: readonly { url: string; text: string }[] = [
  {
    url: 'https://first-outlet.example.com/business/rates-on-hold',
    text: [
      'Rates left on hold as inflation eases',
      'By our economics correspondent. Published 4:31pm.',
      WIRE_BODY,
      'Follow our live markets coverage for reaction through the afternoon.',
    ].join(' '),
  },
  {
    url: 'https://second-outlet.example.org/money/cash-rate-unchanged',
    text: [
      'Cash rate unchanged for a third meeting',
      'Wire services. Updated Tuesday evening.',
      WIRE_BODY,
      'Sign up to our daily money briefing for what this means for your mortgage.',
    ].join(' '),
  },
  {
    url: 'https://third-outlet.example.net/finance/no-change-tuesday',
    text: [
      'No change: board holds at 3.85 per cent',
      'Agency report, with additional editing by our staff.',
      WIRE_BODY,
      'Read more of our coverage of interest rates and household budgets.',
    ].join(' '),
  },
  {
    url: 'https://fourth-outlet.example.io/news/rates-decision',
    text: [
      'Board keeps rates steady, cites services costs',
      'Newsroom, Tuesday.',
      WIRE_BODY,
      'This story was produced from an agency feed and edited locally.',
    ].join(' '),
  },
];

/**
 * The same wire story, cut short by a fifth outlet that ran only the top of it.
 *
 * The case resemblance alone cannot see: a verbatim excerpt shares only its own
 * shingles out of a union the size of the full story, so it scores under the
 * resemblance bar however word-perfect it is, while its containment is close to
 * one. This is the ordinary shape of republication, not an edge case.
 *
 * Cut on a word boundary rather than a character offset, so the join does not
 * leave a fragment that exists in neither document.
 */
const WIRE_WORDS = WIRE_BODY.split(' ');
export const WIRE_TRUNCATED: { url: string; text: string } = {
  url: 'https://fifth-outlet.example.com/brief/rates-hold',
  text: ['Rates hold', ...WIRE_WORDS.slice(0, Math.floor(WIRE_WORDS.length * 0.55))].join(' '),
};

/**
 * Four genuinely independent articles about the same decision.
 *
 * Written from four different desks with four different angles: the general
 * report, the markets note, the household angle and the political one. They
 * share their whole subject vocabulary, which is exactly why they are the right
 * negative control. A detector that keys on shared topic words rather than
 * shared runs of words would merge all four, and the count of independent
 * sources for a well-researched report would silently fall to one.
 */
export const INDEPENDENT_ARTICLES: readonly { url: string; text: string }[] = [
  {
    url: 'https://broadsheet.example.com/economy/hold-again',
    text: [
      'The board has kept the cash rate where it is for a third meeting running, a decision that',
      'surprised almost nobody in the market but will disappoint anyone with a mortgage who had begun',
      'to hope. Underlying inflation is now running at 2.7 per cent, comfortably within the two to',
      'three band the bank aims at, yet the wording gave little away about when relief might arrive.',
      'The governor spent much of her press conference explaining why a number inside the target is',
      'not by itself an argument for cutting. Services costs, she said, are still rising faster than',
      'anyone would like, and employment has proved more resilient than the forecasts assumed. The',
      'currency firmed slightly. Traders trimmed their bets on a September move and pushed the bulk',
      'of the expected easing into the final months of the year. For borrowers, the practical answer',
      'is that nothing changes this month and probably not next month either.',
    ].join(' '),
  },
  {
    url: 'https://markets-desk.example.org/rates/repricing',
    text: [
      'Rate expectations shifted late in the day after the central bank declined to move, leaving its',
      'benchmark at three point eight five per cent. Swap markets, which had assigned roughly a thirty',
      'per cent probability to a reduction, now put the first full cut in November. Three year yields',
      'added four basis points and the currency gained about a quarter of a US cent, a modest',
      'repricing that reflects how well telegraphed the outcome had been. Strategists pointed to the',
      'trimmed mean measure, which slowed to two point seven per cent on an annual basis, as evidence',
      'that the disinflation is real but not yet finished. The sticking point is services, where price',
      'growth has been slow to follow goods down. One desk noted that the board has never eased into a',
      'labour market this tight without a clear trigger, and that no such trigger has appeared yet.',
    ].join(' '),
  },
  {
    url: 'https://household-money.example.net/mortgages/what-it-means',
    text: [
      'Home owners hoping for cheaper repayments will have to wait at least another six weeks. The',
      'people who set the cost of money in this country met on Tuesday and chose to do nothing, which',
      'on an average loan of six hundred thousand dollars means a monthly payment that does not budge.',
      'Brokers report that refinancing enquiries have climbed steadily since autumn as borrowers hunt',
      'for a better deal rather than wait for one to arrive. Comparison sites list a handful of lenders',
      'already discounting ahead of any official move. The advice from financial counsellors has not',
      'changed: check what you are actually paying, ask your lender to match the best advertised offer,',
      'and treat any saving as a chance to get ahead on the principal rather than as extra spending',
      'money each month. Nothing about this decision changes that arithmetic in either direction.',
    ].join(' '),
  },
  {
    url: 'https://politics-daily.example.io/canberra/both-sides-claim-credit',
    text: [
      'The treasurer welcomed Tuesday afternoon as evidence that the government fiscal restraint is',
      'working, while the opposition used the very same numbers to argue the opposite. With inflation',
      'now inside the target band for a second consecutive quarter, both sides claimed vindication,',
      'which is roughly what happens every time the central bank publishes anything at all.',
      'Independent economists were less interested in the politics than in the wording of the',
      'accompanying statement, which dropped a phrase about remaining vigilant that had appeared in',
      'each of the previous two. Small changes of that kind are how a board signals a shift without',
      'committing itself to one. Whether it amounts to anything will depend on the quarterly figures',
      'due next month, and on whether services costs finally follow the rest of the basket downward.',
    ].join(' '),
  },
];

/**
 * Pages that are not articles.
 *
 * Short, near-identical wherever they are served, and the reason `MIN_SHINGLES`
 * exists: merging two of these would collapse two genuinely independent
 * publishers on the strength of two error pages.
 */
export const BOILERPLATE_PAGES: readonly { url: string; text: string }[] = [
  {
    url: 'https://paywalled.example.com/business/rates',
    text: 'Subscribe to continue reading. Already a subscriber? Sign in. Get unlimited access from $4 a week. Cancel any time.',
  },
  {
    url: 'https://walled.example.org/finance/rates',
    text: 'Subscribe to continue reading. Already a subscriber? Sign in. Get unlimited access from $4 a week. Cancel any time.',
  },
];
