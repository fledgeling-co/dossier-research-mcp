import { readDetectorCorpus } from '../files.js';
import { renderReport, scoreDetector } from '../report.js';
const corpus = readDetectorCorpus();
console.log(renderReport(await scoreDetector(corpus)));
