#!/usr/bin/env node
import dotenv from 'dotenv';
import { neon } from '@neondatabase/serverless';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit, standalone utility. It is not imported by the API or any package script.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(scriptDir, '../.env') });

const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(['--dry-run', '--apply', '--allow-production']);
for (const arg of args) {
  if (!allowedArgs.has(arg)) throw new Error(`Unknown option: ${arg}`);
}
if (args.has('--dry-run') && args.has('--apply')) {
  throw new Error('Choose either --dry-run or --apply, not both.');
}
// Preview is the default. Database writes require the explicit --apply flag.
const dryRun = !args.has('--apply') || args.has('--dry-run');
const allowProduction = args.has('--allow-production');
const targetCatalogCount = 100;
const targetExamCount = 20;
const questionsPerExam = 20;

if (process.env.NODE_ENV === 'production' && !dryRun && !allowProduction) {
  throw new Error('Refusing to write to production. Review the target, then rerun with --allow-production.');
}
if (!process.env.DATABASE_URL) {
  throw new Error(`DATABASE_URL is missing. Set it in ${path.resolve(scriptDir, '../.env')} or the environment.`);
}

const sql = neon(process.env.DATABASE_URL);
const unique = (values) => [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];

function makeQuestion(topic, body, answer, distractors, explanation, variantIndex = 0) {
  const choices = unique([answer, ...distractors]);
  let suffix = 1;
  while (choices.length < 4) choices.push(`${answer} (${suffix++})`);
  const shift = variantIndex % 4;
  const rotated = choices.slice(shift).concat(choices.slice(0, shift));
  return {
    topic, body, image: null,
    opt_a: rotated[0], opt_b: rotated[1], opt_c: rotated[2], opt_d: rotated[3],
    correct: ['A', 'B', 'C', 'D'][rotated.indexOf(String(answer))],
    explanation,
  };
}

function numericQuestion(topic, body, answer, unit, explanation, seed) {
  const wrong = unique([
    Math.max(0, answer + 2), Math.max(0, answer - 2), answer * 2 + 1, answer + 5,
  ]).filter((value) => value !== answer).slice(0, 3);
  const format = (value) => `${value} ${unit}`.trim();
  return makeQuestion(topic, body, format(answer), wrong.map(format), explanation, seed);
}

function physicsQuestions() {
  const questions = [];
  for (let i = 0; i < 10; i += 1) {
    const speed = i + 4;
    const time = i + 2;
    questions.push(numericQuestion('Speed and distance',
      `A cyclist travels ${speed * time} m in ${time} s. What is the cyclist's average speed?`,
      speed, 'm/s', 'Average speed = distance ÷ time.', i));

    const acceleration = i + 2;
    const accelTime = i + 1;
    const initialVelocity = 3;
    const finalVelocity = initialVelocity + acceleration * accelTime;
    questions.push(numericQuestion('Acceleration',
      `A cart speeds up from ${initialVelocity} m/s to ${finalVelocity} m/s in ${accelTime} s. What is its acceleration?`,
      acceleration, 'm/s²', 'Acceleration = change in velocity ÷ time.', i + 10));

    const mass = i + 2;
    const forceAcceleration = 12 - i;
    questions.push(numericQuestion('Newton’s second law',
      `What net force acts on a ${mass} kg object accelerating at ${forceAcceleration} m/s²?`,
      mass * forceAcceleration, 'N', 'Newton’s second law gives F = m × a.', i + 20));

    const appliedForce = (i + 1) * 10;
    const distance = i + 1;
    questions.push(numericQuestion('Work and energy',
      `A constant ${appliedForce} N force moves a box ${distance} m in the force direction. How much work is done?`,
      appliedForce * distance, 'J', 'For parallel force and displacement, work = force × distance.', i + 30));

    const power = (i + 2) * 5;
    const powerTime = i + 1;
    questions.push(numericQuestion('Power',
      `A machine transfers ${power * powerTime} J of energy in ${powerTime} s. What is its power?`,
      power, 'W', 'Power = energy transferred ÷ time.', i + 40));

    const momentumMass = i + 1;
    const velocity = i + 3;
    questions.push(numericQuestion('Momentum',
      `What is the momentum of a ${momentumMass} kg ball moving at ${velocity} m/s?`,
      momentumMass * velocity, 'kg·m/s', 'Momentum = mass × velocity.', i + 50));

    const kineticVelocity = i + 2;
    questions.push(numericQuestion('Kinetic energy',
      `A 2 kg object moves at ${kineticVelocity} m/s. What is its kinetic energy?`,
      kineticVelocity ** 2, 'J', 'Kinetic energy = ½mv²; with m = 2 kg, this is v².', i + 60));

    const heightMass = i + 1;
    const height = i + 2;
    questions.push(numericQuestion('Gravitational potential energy',
      `Using g = 10 m/s², how much gravitational potential energy does a ${heightMass} kg object gain when lifted ${height} m?`,
      heightMass * 10 * height, 'J', 'Gravitational potential energy change = mgh.', i + 70));

    const area = i + 1;
    const pressure = i + 5;
    questions.push(numericQuestion('Pressure',
      `A ${area * pressure} N force acts uniformly over ${area} m². What pressure is exerted?`,
      pressure, 'Pa', 'Pressure = force ÷ area.', i + 80));

    const volume = i + 2;
    const density = i + 3;
    questions.push(numericQuestion('Density',
      `A sample has mass ${volume * density} kg and volume ${volume} m³. What is its density?`,
      density, 'kg/m³', 'Density = mass ÷ volume.', i + 90));
  }
  return questions;
}

function mathematicsQuestions() {
  const questions = [];
  for (let i = 0; i < 10; i += 1) {
    const x = i + 2;
    const addend = 3 * i + 4;
    questions.push(numericQuestion('Linear equations', `Solve for x: x + ${addend} = ${x + addend}.`, x, '',
      'Subtract the known addend from both sides.', i));

    const minuend = 4 * i + 25;
    const subtrahend = i + 3;
    questions.push(numericQuestion('Integer operations', `Evaluate ${minuend} − ${subtrahend}.`, minuend - subtrahend, '',
      'Subtract the second number from the first.', i + 10));

    const factorA = i + 2;
    const factorB = i + 5;
    questions.push(numericQuestion('Multiplication', `What is ${factorA} × ${factorB}?`, factorA * factorB, '',
      'Multiply the two factors.', i + 20));

    const total = 30 * (i + 1);
    questions.push(numericQuestion('Percentages', `What is 10% of ${total}?`, total / 10, '',
      'Ten percent is one tenth of the whole.', i + 30));

    const scale = i + 1;
    questions.push(numericQuestion('Ratios',
      `The ratio of red to blue beads is 2:3. If there are ${2 * scale} red beads, how many blue beads are there?`,
      3 * scale, '', 'Scale both parts of the ratio by the same factor.', i + 40));

    const first = i + 1;
    const difference = (i % 5) + 2;
    const position = i + 6;
    questions.push(numericQuestion('Arithmetic sequences',
      `An arithmetic sequence starts at ${first} and increases by ${difference} each term. What is its ${position}th term?`,
      first + (position - 1) * difference, '', 'The nth term is first term + (n − 1) × common difference.', i + 50));

    const average = i + 4;
    questions.push(numericQuestion('Averages',
      `Find the mean of ${average - 3}, ${average - 1}, ${average + 1}, and ${average + 3}.`,
      average, '', 'The mean is the sum divided by the number of values.', i + 60));

    const length = i + 3;
    const width = i + 2;
    questions.push(numericQuestion('Area of rectangles', `What is the area of a rectangle ${length} cm long and ${width} cm wide?`,
      length * width, 'cm²', 'Rectangle area = length × width.', i + 70));

    const base = 2 * (i + 1);
    const triangleHeight = i + 2;
    questions.push(numericQuestion('Area of triangles',
      `A triangle has base ${base} cm and height ${triangleHeight} cm. What is its area?`,
      (base * triangleHeight) / 2, 'cm²', 'Triangle area = ½ × base × perpendicular height.', i + 80));

    const root = i + 2;
    questions.push(numericQuestion('Square roots', `What is the principal square root of ${root ** 2}?`, root, '',
      'The principal square root is the non-negative number whose square equals the radicand.', i + 90));
  }
  return questions;
}

const elementNames = {
  H: 'hydrogen', C: 'carbon', O: 'oxygen', N: 'nitrogen', S: 'sulfur',
  Na: 'sodium', Cl: 'chlorine', Ca: 'calcium', Mg: 'magnesium',
};
const compounds = [
  ['water', 'H2O'], ['carbon dioxide', 'CO2'], ['methane', 'CH4'], ['ammonia', 'NH3'],
  ['sodium chloride', 'NaCl'], ['sulfuric acid', 'H2SO4'], ['hydrogen chloride', 'HCl'],
  ['sodium hydroxide', 'NaOH'], ['oxygen gas', 'O2'], ['ozone', 'O3'], ['glucose', 'C6H12O6'],
  ['calcium carbonate', 'CaCO3'], ['nitric acid', 'HNO3'], ['ethanoic acid', 'CH3COOH'],
  ['sodium hydrogen carbonate', 'NaHCO3'], ['ethanol', 'C2H5OH'], ['hydrogen peroxide', 'H2O2'],
  ['magnesium oxide', 'MgO'], ['calcium oxide', 'CaO'], ['sodium carbonate', 'Na2CO3'],
];

function parseFormula(formula) {
  const counts = {};
  for (const [, symbol, subscript] of formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    counts[symbol] = (counts[symbol] || 0) + Number(subscript || 1);
  }
  return counts;
}

function chemistryQuestions() {
  const questions = [];
  const data = compounds.map(([name, formula]) => ({ name, formula, counts: parseFormula(formula) }));
  data.forEach((compound, index) => {
    const others = data.filter((_, otherIndex) => otherIndex !== index);
    const symbols = Object.keys(compound.counts);
    const elementList = symbols.map((symbol) => elementNames[symbol] || symbol).join(', ');
    const atomCount = Object.values(compound.counts).reduce((sum, count) => sum + count, 0);
    const chosenSymbol = symbols[0];
    const chosenCount = compound.counts[chosenSymbol];
    const elementDistractors = unique(['hydrogen and oxygen', 'carbon and oxygen', 'sodium and chlorine', 'carbon, hydrogen and oxygen'])
      .filter((value) => value !== elementList).slice(0, 3);
    const explanation = `${compound.name} is represented by ${compound.formula}.`;
    const topic = `Formula: ${compound.name}`;

    questions.push(makeQuestion(topic, `Which formula represents ${compound.name}?`, compound.formula,
      others.map((item) => item.formula), explanation, index * 5));
    questions.push(makeQuestion(topic, `Which compound has the formula ${compound.formula}?`, compound.name,
      others.map((item) => item.name), explanation, index * 5 + 1));
    questions.push(makeQuestion(topic, `How many atoms are shown in one molecule or formula unit of ${compound.name}?`, String(atomCount),
      [String(atomCount + 1), String(Math.max(1, atomCount - 1)), String(atomCount + 2)],
      `Add the subscripts in ${compound.formula}; the total is ${atomCount}.`, index * 5 + 2));
    questions.push(makeQuestion(topic,
      `How many ${elementNames[chosenSymbol] || chosenSymbol} atoms are present in one molecule or formula unit of ${compound.name}?`,
      String(chosenCount), [String(chosenCount + 1), String(Math.max(1, chosenCount - 1)), String(chosenCount + 2)],
      `Read the subscript after ${chosenSymbol} in ${compound.formula}; an omitted subscript means one.`, index * 5 + 3));
    questions.push(makeQuestion(topic, `Which set of elements is present in ${compound.name}?`, elementList,
      elementDistractors, `${compound.formula} contains ${elementList}.`, index * 5 + 4));
  });
  return questions;
}

const biologyFacts = [
  ['Mitochondrion', 'produces most of the cell’s ATP during aerobic respiration', 'the cell needs to release usable energy from nutrients'],
  ['Nucleus', 'stores most of the cell’s genetic material and helps regulate cell activity', 'a cell reads genetic instructions to control its activities'],
  ['Ribosome', 'assembles amino acids into proteins', 'a cell is translating an mRNA message into a protein'],
  ['Cell membrane', 'controls the movement of substances into and out of the cell', 'a cell selectively allows ions and nutrients to cross its boundary'],
  ['Chloroplast', 'carries out photosynthesis in plant cells', 'a leaf cell uses light energy to make sugars'],
  ['Xylem', 'transports water and mineral ions from roots through a plant', 'water is moving upward from roots toward leaves'],
  ['Phloem', 'transports sugars and other organic nutrients around a plant', 'sucrose made in a leaf is being moved to a growing root'],
  ['Nephron', 'filters blood and helps form urine in the kidney', 'the kidney filters wastes and adjusts water balance'],
  ['Alveolus', 'provides a thin surface for gas exchange in the lungs', 'oxygen diffuses into blood and carbon dioxide diffuses out'],
  ['Hemoglobin', 'binds and transports oxygen in red blood cells', 'oxygen is being carried from the lungs to body tissues'],
  ['Insulin', 'helps lower blood glucose by promoting uptake and storage', 'blood glucose rises after a meal and needs to be regulated'],
  ['Antibody', 'binds a specific antigen and helps target a pathogen', 'the immune system recognizes a particular foreign antigen'],
  ['Vaccine', 'trains immune memory to respond to a specific pathogen', 'a person receives a preparation to develop protection before exposure'],
  ['Enzyme', 'acts as a biological catalyst and lowers activation energy', 'a reaction in a cell proceeds faster without the catalyst being consumed'],
  ['Meiosis', 'produces genetically varied haploid gametes', 'an organism makes sex cells with half the usual chromosome number'],
  ['Mitosis', 'produces genetically similar cells for growth and repair', 'a tissue replaces damaged cells while maintaining chromosome number'],
  ['DNA', 'stores hereditary information in a sequence of nucleotides', 'a cell passes genetic instructions to daughter cells'],
  ['Stoma', 'allows regulated gas exchange between a leaf and the air', 'carbon dioxide enters a leaf while water vapour can leave'],
  ['Pancreas', 'produces hormones including insulin and glucagon', 'the body needs hormones that regulate blood glucose'],
  ['Neuron', 'transmits information using electrical and chemical signals', 'a nerve cell carries a signal toward another cell'],
];

function knowledgeQuestions(facts, subject) {
  const questions = [];
  facts.forEach(([term, definition, scenario], index) => {
    const others = facts.filter((_, otherIndex) => otherIndex !== index);
    const terms = others.map(([otherTerm]) => otherTerm);
    const definitions = others.map(([, otherDefinition]) => otherDefinition);
    const pairs = others.map(([otherTerm, otherDefinition]) => `${otherTerm} — ${otherDefinition}`);
    const topic = `${subject}: ${term}`;
    const explanation = `${term}: ${definition}.`;
    questions.push(makeQuestion(topic, `What is the primary role of ${term}?`, definition, definitions, explanation, index * 5));
    questions.push(makeQuestion(topic, `Which biological structure or molecule ${definition}?`, term, terms, explanation, index * 5 + 1));
    questions.push(makeQuestion(topic, `A student observes that ${scenario}. Which structure or molecule is most directly involved?`, term, terms, explanation, index * 5 + 2));
    questions.push(makeQuestion(topic, `A study note asks for the main role of ${term}. Which function should it list?`, definition, definitions, explanation, index * 5 + 3));
    questions.push(makeQuestion(topic, 'Which pair correctly matches a biological structure or molecule with its role?', `${term} — ${definition}`, pairs, explanation, index * 5 + 4));
  });
  return questions;
}

const computerScienceFacts = [
  ['CPU', 'executes program instructions and coordinates processing', 'a device fetches and executes machine instructions'],
  ['RAM', 'temporarily stores data and programs currently in use and is volatile', 'working data is lost when power is removed'],
  ['ROM', 'retains non-volatile instructions such as firmware', 'startup instructions must remain available without power'],
  ['Operating system', 'manages hardware resources and provides services to applications', 'software schedules processes and manages memory and devices'],
  ['Algorithm', 'is a finite, ordered set of steps for solving a problem', 'a programmer describes an exact procedure before coding'],
  ['Variable', 'stores a value that a program can refer to and may update', 'a program needs a named place to keep a changing score'],
  ['Loop', 'repeats a block of instructions while a condition or count allows', 'the same calculation must be performed for every item in a list'],
  ['Stack', 'uses last-in, first-out ordering', 'the most recently added item must be removed first'],
  ['Queue', 'uses first-in, first-out ordering', 'requests should be processed in the order they arrived'],
  ['Binary', 'represents values using the digits 0 and 1', 'a computer stores a number using two possible digit symbols'],
  ['Compiler', 'translates source code into another form such as machine code', 'a program is translated before it is executed'],
  ['DNS', 'maps domain names to IP addresses', 'a browser needs the network address associated with a domain'],
  ['Router', 'forwards packets between networks', 'data packets need to travel from a local network to another network'],
  ['Firewall', 'filters network traffic according to security rules', 'an administrator blocks unauthorized network connections'],
  ['Primary key', 'uniquely identifies each row in a database table', 'a table needs a non-duplicate identifier for every record'],
  ['SQL', 'is used to define, query, and manipulate relational databases', 'an application retrieves rows from a relational database'],
  ['HTML', 'defines the structure and content of web pages', 'a developer marks headings, paragraphs, and links on a page'],
  ['CSS', 'controls the presentation and layout of web documents', 'a developer changes colors, spacing, and typography on a page'],
  ['HTTPS', 'protects HTTP communication using TLS encryption and authentication', 'a browser establishes an encrypted connection to a website'],
  ['Cache', 'keeps copies of frequently used data for faster access', 'a system saves recently used data close to the processor'],
];

const englishItems = [
  ['Past simple: go', 'went', ['goed', 'gone', 'goes'], ['Yesterday, Amina ___ to the library.', 'Last week, we ___ to the museum.', 'The players ___ home after the match.', 'He ___ to class before the rain began.', 'They ___ by bus on Monday.'], 'The past simple of “go” is “went”.'],
  ['Past simple: write', 'wrote', ['written', 'writed', 'writes'], ['She ___ a letter to her cousin yesterday.', 'I ___ the summary last night.', 'They ___ their names on the form.', 'He ___ a short story in class.', 'We ___ notes during the lecture.'], 'The past simple of “write” is “wrote”.'],
  ['Irregular plural nouns', 'children', ['childs', 'childrens', 'childes'], ['The ___ played in the garden.', 'Several ___ joined the science club.', 'The teacher read a story to the ___.', 'Those ___ are waiting for the bus.', 'Many ___ visited the exhibition.'], '“Child” has the irregular plural “children”.'],
  ['Articles', 'an', ['a', 'the', 'no article'], ['She waited for ___ hour.', 'He is ___ honest student.', 'We saw ___ eagle above the valley.', 'Please bring ___ umbrella.', 'They made ___ unusual discovery.'], 'Use “an” before a vowel sound; the h in “hour” is silent.'],
  ['Subject–verb agreement', 'is', ['are', 'were', 'be'], ['The list of books ___ on the desk.', 'Each answer ___ worth one mark.', 'The color of these leaves ___ changing.', 'A box of old photographs ___ in the attic.', 'The first chapter ___ quite short.'], 'A singular subject takes “is” in the present tense.'],
  ['Subject–verb agreement', 'are', ['is', 'was', 'be'], ['The students ___ ready for the quiz.', 'My friends ___ waiting outside.', 'Several bright stars ___ visible tonight.', 'The new computers ___ in the lab.', 'Both answers ___ acceptable.'], 'A plural subject takes “are” in the present tense.'],
  ['Comparative adjectives', 'better', ['best', 'gooder', 'well'], ['This solution is ___ than the first one.', 'Her second draft is much ___.', 'The weather became ___ by afternoon.', 'Your explanation is ___ than mine.', 'The new route is ___ for cyclists.'], 'The irregular comparative form of “good” is “better”.'],
  ['Superlative adjectives', 'tallest', ['taller', 'most tall', 'tall'], ['That is the ___ building in the city.', 'Mina is the ___ player on the team.', 'This tree is the ___ in the park.', 'He was the ___ student in his family.', 'Which mountain is the ___ in this range?'], 'Use the superlative “tallest” when comparing one with a whole group.'],
  ['Possessive pronouns', 'their', ['there', 'they’re', 'them'], ['The students left ___ books in the classroom.', 'The birds returned to ___ nest.', 'The players packed ___ equipment.', 'The twins finished ___ project together.', 'The workers wore ___ safety helmets.'], '“Their” shows possession by more than one person or thing.'],
  ['Its and it’s', 'its', ['it’s', 'its’', 'it is'], ['The cat licked ___ paw.', 'The company changed ___ policy.', 'The tree lost ___ leaves in winter.', 'The bird built ___ nest on the ledge.', 'The phone returned to ___ default settings.'], '“Its” is possessive; “it’s” means “it is” or “it has”.'],
  ['You’re and your', 'You’re', ['Your', 'Yours', 'You'], ['___ welcome to join our study group.', '___ going to enjoy the new library.', '___ responsible for checking the final copy.', '___ almost finished with the assignment.', '___ invited to the science fair.'], '“You’re” is the contraction of “you are”.'],
  ['There, their, and they’re', 'There', ['Their', 'They’re', 'They'], ['___ are three notebooks on the table.', '___ is a quiet place to study upstairs.', '___ were several questions after the talk.', '___ are two ways to solve this problem.', '___ was a message for you at reception.'], '“There” introduces or points out a place or existence.'],
  ['Countable nouns', 'fewer', ['less', 'little', 'fewest than'], ['There are ___ chairs in this room than in the hall.', 'We made ___ spelling errors this time.', 'The second class had ___ absences.', 'Use ___ plastic bags if possible.', 'This route has ___ traffic lights.'], 'Use “fewer” with countable plural nouns.'],
  ['Uncountable nouns', 'less', ['fewer', 'few', 'least than'], ['Please add ___ sugar to the tea.', 'This bottle contains ___ water than that one.', 'We have ___ time than we expected.', 'The new engine uses ___ fuel.', 'Try to make ___ noise in the reading room.'], 'Use “less” with uncountable quantities.'],
  ['Relative pronouns', 'who', ['whom', 'which', 'whose'], ['The student ___ won the prize thanked her teacher.', 'I met a scientist ___ studies marine life.', 'The athlete ___ broke the record trains daily.', 'She is the neighbor ___ helped us.', 'The guide ___ led the group knew the trail.'], 'Use “who” for a person performing the action in the relative clause.'],
  ['Relative pronouns', 'whom', ['who', 'which', 'whose'], ['The teacher ___ we met spoke three languages.', 'The student to ___ I gave the note smiled.', 'The author ___ they interviewed lives nearby.', 'The coach with ___ we practiced was patient.', 'The person ___ you called has arrived.'], 'Use “whom” for a person receiving the action or following a preposition.'],
  ['Subject–verb agreement', 'has', ['have', 'are', 'were'], ['Each student ___ a workbook.', 'Every room ___ a window.', 'One of the players ___ a blue jersey.', 'Neither answer ___ the correct unit.', 'Someone ___ left a notebook here.'], '“Each”, “every”, “one”, “neither”, and “someone” take a singular verb.'],
  ['Past tense of be', 'were', ['was', 'are', 'be'], ['They ___ waiting when the bus arrived.', 'We ___ proud of the team.', 'The children ___ at the science center.', 'You ___ right about the answer.', 'My classmates ___ ready for the presentation.'], 'Use “were” with “you”, “we”, and plural subjects in the past tense.'],
  ['Prepositions of time', 'at', ['in', 'on', 'by'], ['The lesson begins ___ 9:00 a.m.', 'The bus leaves ___ noon.', 'The meeting starts ___ midnight.', 'We usually eat lunch ___ 1:15.', 'The final bell rings ___ 3:30.'], 'Use “at” for a specific clock time.'],
  ['Passive voice', 'was written', ['wrote', 'has writing', 'is write'], ['The report ___ by Sara yesterday.', 'The poem ___ by the student last week.', 'The final notice ___ by the principal.', 'The short story ___ by a local author.', 'The answer ___ on the board before class.'], 'The simple past passive uses “was/were” + past participle.'],
];

function englishQuestions() {
  const questions = [];
  englishItems.forEach(([topic, answer, distractors, sentences, explanation], conceptIndex) => {
    sentences.forEach((sentence, variantIndex) => {
      questions.push(makeQuestion(topic,
        `Choose the option that correctly completes the sentence: ${sentence.replace('___', '____')}`,
        answer, distractors, explanation, conceptIndex * 5 + variantIndex));
    });
  });
  return questions;
}

function generateQuestions(subjectName) {
  const subject = String(subjectName).toLowerCase();
  if (/physics/.test(subject)) return physicsQuestions();
  if (/chemistry/.test(subject)) return chemistryQuestions();
  if (/mathematics|math/.test(subject)) return mathematicsQuestions();
  if (/biology/.test(subject)) return knowledgeQuestions(biologyFacts, 'Cell biology and physiology');
  if (/computer science|information technology|programming/.test(subject)) {
    return knowledgeQuestions(computerScienceFacts, 'Computer science');
  }
  if (/english/.test(subject)) return englishQuestions();
  throw new Error(`No content bank is included for subject “${subjectName}”. Add its MCQ bank before seeding.`);
}

function chooseExamQuestions(rows, rotation) {
  const groups = new Map();
  for (const row of rows) {
    const topic = row.topic || 'General';
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(Number(row.id));
  }
  const topics = [...groups.keys()].sort();
  if (!topics.length) throw new Error('No active catalog questions were found for an exam.');
  const offset = rotation % topics.length;
  const orderedTopics = topics.slice(offset).concat(topics.slice(0, offset));
  const selected = [];
  for (let round = 0; selected.length < questionsPerExam; round += 1) {
    let addedThisRound = 0;
    for (const topic of orderedTopics) {
      const ids = groups.get(topic);
      const id = ids[(rotation + round) % ids.length];
      if (!selected.includes(id)) {
        selected.push(id);
        addedThisRound += 1;
        if (selected.length === questionsPerExam) break;
      }
    }
    if (!addedThisRound) break;
  }
  if (selected.length < questionsPerExam) {
    throw new Error(`Need ${questionsPerExam} distinct active questions per course; found only ${selected.length}.`);
  }
  return selected;
}

async function loadCourses() {
  return sql`
    SELECT c.id AS course_id, c.class_id, cl.name AS class_name, s.name AS subject_name,
      COALESCE(
        (SELECT tc.user_id FROM teacher_courses tc JOIN users u ON u.id = tc.user_id
         WHERE tc.course_id = c.id AND u.role = 3 AND COALESCE(u.is_active, TRUE)
         ORDER BY tc.user_id LIMIT 1),
        (SELECT u.id FROM users u WHERE u.role IN (1, 2) AND COALESCE(u.is_active, TRUE)
         ORDER BY u.role, u.id LIMIT 1)
      ) AS created_by,
      (SELECT COUNT(*)::int FROM questions q WHERE q.course_id = c.id AND q.is_active = TRUE) AS active_count
    FROM courses c
    JOIN classes cl ON cl.id = c.class_id
    JOIN subjects s ON s.id = c.subject_id
    ORDER BY c.class_id, s.name, c.id
  `;
}

async function insertQuestionBatch(course, questions) {
  if (!questions.length) return 0;
  const records = questions.map((question) => ({ ...question, course_id: course.course_id, created_by: course.created_by }));
  const payload = JSON.stringify(records);
  const inserted = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    SELECT incoming.course_id, incoming.topic, incoming.body, incoming.image,
           incoming.opt_a, incoming.opt_b, incoming.opt_c, incoming.opt_d,
           incoming.correct, incoming.explanation, incoming.created_by
    FROM jsonb_to_recordset(${payload}::jsonb) AS incoming(
      course_id integer, topic text, body text, image text,
      opt_a text, opt_b text, opt_c text, opt_d text,
      correct text, explanation text, created_by integer
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM questions q
      WHERE q.course_id = incoming.course_id AND q.body = incoming.body AND q.is_active = TRUE
    )
    RETURNING id
  `;
  return inserted.length;
}

async function ensureCatalog(courses) {
  for (const course of courses) {
    const activeCount = Number(course.active_count);
    const missingCount = Math.max(0, targetCatalogCount - activeCount);
    if (!missingCount) {
      console.log(`Catalog ${course.subject_name} / ${course.class_name}: already has ${activeCount} active MCQs.`);
      continue;
    }
    const bank = generateQuestions(course.subject_name);
    if (bank.length < missingCount) throw new Error(`The ${course.subject_name} bank has only ${bank.length} questions; ${missingCount} are needed.`);
    const existing = await sql`SELECT body FROM questions WHERE course_id = ${course.course_id} AND is_active = TRUE`;
    const activeBodies = new Set(existing.map((row) => row.body));
    const newQuestions = bank.filter((question) => !activeBodies.has(question.body)).slice(0, missingCount);
    if (newQuestions.length < missingCount) throw new Error(`Could not prepare enough distinct ${course.subject_name} MCQs for ${course.class_name}.`);

    if (dryRun) {
      console.log(`DRY RUN — Catalog ${course.subject_name} / ${course.class_name}: would add ${newQuestions.length} MCQs (${activeCount} → ${activeCount + newQuestions.length}).`);
      course.active_count = activeCount + newQuestions.length;
      continue;
    }
    const inserted = await insertQuestionBatch(course, newQuestions);
    const [countRow] = await sql`SELECT COUNT(*)::int AS count FROM questions WHERE course_id = ${course.course_id} AND is_active = TRUE`;
    const finalCount = Number(countRow.count);
    if (finalCount < targetCatalogCount) throw new Error(`Catalog seeding stopped at ${finalCount} active ${course.subject_name} MCQs for ${course.class_name}.`);
    course.active_count = finalCount;
    console.log(`Catalog ${course.subject_name} / ${course.class_name}: added ${inserted}; now ${finalCount} active MCQs.`);
  }
}

async function ensureExams(courses) {
  const examTotal = Math.max(targetExamCount, courses.length);
  const ordinalByCourse = new Map();
  const now = new Date();
  const startAt = new Date(now.getTime() - 60_000).toISOString();
  const endAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
  let created = 0;
  let reused = 0;

  for (let index = 0; index < examTotal; index += 1) {
    const course = courses[index % courses.length];
    const ordinal = (ordinalByCourse.get(course.course_id) || 0) + 1;
    ordinalByCourse.set(course.course_id, ordinal);
    const title = `Practice Exam ${String(ordinal).padStart(2, '0')} — ${course.subject_name} — ${course.class_name}`;
    const questionRows = await sql`SELECT id, topic FROM questions WHERE course_id = ${course.course_id} AND is_active = TRUE ORDER BY id`;

    if (dryRun && questionRows.length < questionsPerExam) {
      console.log(`DRY RUN — would create ${title} with ${questionsPerExam} questions after catalog seeding.`);
      created += 1;
      continue;
    }
    const questionIds = chooseExamQuestions(questionRows, ordinal - 1);
    const [existingTest] = await sql`
      SELECT t.id, COUNT(tq.question_id)::int AS question_count
      FROM tests t LEFT JOIN test_questions tq ON tq.test_id = t.id
      WHERE t.course_id = ${course.course_id} AND t.section_id IS NULL AND t.title = ${title}
      GROUP BY t.id LIMIT 1
    `;
    if (!existingTest && dryRun) {
      console.log(`DRY RUN — would create ${title} with ${questionsPerExam} questions.`);
      created += 1;
      continue;
    }

    let testId;
    if (existingTest) {
      testId = Number(existingTest.id);
      if (Number(existingTest.question_count) >= questionsPerExam) {
        reused += 1;
        continue;
      }
      const [attempt] = await sql`SELECT 1 FROM attempts WHERE test_id = ${testId} LIMIT 1`;
      if (attempt) {
        console.warn(`Skipping ${title}: it has student attempts and fewer than ${questionsPerExam} questions.`);
        reused += 1;
        continue;
      }
    } else {
      const [createdTest] = await sql`
        INSERT INTO tests (
          course_id, section_id, title, duration_min, mark_per_q, neg_mark,
          shuffle_q, shuffle_opt, start_at, end_at, result_mode, results_released, status, created_by
        ) VALUES (
          ${course.course_id}, NULL, ${title}, 40, 1, 0,
          TRUE, TRUE, ${startAt}, ${endAt}, 1, TRUE, 2, ${course.created_by}
        ) RETURNING id
      `;
      testId = Number(createdTest.id);
      created += 1;
    }

    const existingLinks = await sql`SELECT question_id FROM test_questions WHERE test_id = ${testId}`;
    const linkedIds = new Set(existingLinks.map((row) => Number(row.question_id)));
    const addIds = questionIds.filter((id) => !linkedIds.has(id)).slice(0, questionsPerExam - linkedIds.size);
    if (addIds.length) {
      await sql`
        INSERT INTO test_questions (test_id, question_id)
        SELECT ${testId}, selected.question_id
        FROM unnest(${addIds}::int[]) AS selected(question_id)
        ON CONFLICT DO NOTHING
      `;
    }
  }
  console.log(`${dryRun ? 'DRY RUN — ' : ''}Exams: ${created} to create; ${reused} existing seed exams reused. Each new exam has ${questionsPerExam} questions.`);
}

async function main() {
  const courses = await loadCourses();
  if (!courses.length) throw new Error('No courses were found. Create classes, subjects, and courses before running this standalone seed.');
  const missingCreator = courses.filter((course) => !course.created_by);
  if (missingCreator.length) {
    const labels = missingCreator.map((course) => `${course.subject_name} / ${course.class_name}`).join(', ');
    throw new Error(`No active assigned teacher or active admin/operator can own seeded content for: ${labels}`);
  }
  // Validate all subject banks before writing, so unsupported subjects cannot cause a partial seed.
  for (const course of courses) generateQuestions(course.subject_name);

  console.log(`${dryRun ? 'Previewing' : 'Seeding'} ${courses.length} course(s): target ${targetCatalogCount} active MCQs per course and at least ${targetExamCount} exams with ${questionsPerExam} questions each.`);
  await ensureCatalog(courses);
  await ensureExams(courses);
  console.log(dryRun ? 'Dry run complete; the database was not changed.' : 'Standalone exam and catalog seed complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Standalone seed failed.');
  process.exitCode = 1;
});
