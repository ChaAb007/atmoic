/**
 * A test history: how OrbitAI was started, told as the exchanges the person had with Surface in March-April 2026,
 * about six months before this prototype was handed over. Loaded through the normal Atomic pipeline (each ask and
 * reply goes through the layers with its own date), so recall can be tested on old memory. It mixes every kind of
 * memory on purpose: hard facts and dates, decisions, feelings and casual talk.
 */
export interface StoryExchange {
  at: string;
  ask: string;
  response: string;
}

export const ORBITAI_STORY_NAME = 'OrbitAI story (March-April 2026)';

export const ORBITAI_STORY: StoryExchange[] = [
  // The idea
  {
    at: '2026-03-02T22:40:00+05:30',
    ask: "Couldn't sleep. Visited my uncle's screw factory in Rajkot today and his whole business runs on WhatsApp voice notes and a red diary. Orders get missed every week. I think there's a company in this.",
    response: "That's a real pain point you saw first-hand. Factories like your uncle's run on voice notes and memory, not software. What would the first thing you build for him be?",
  },
  {
    at: '2026-03-02T22:52:00+05:30',
    ask: 'An assistant that listens to the voice notes in Hindi and Gujarati, creates the order, and reminds people of due payments. Like a memory for the factory.',
    response: 'A memory for the factory is a sharp way to put it. Start with orders and payment reminders only; that alone saves your uncle money every week.',
  },
  {
    at: '2026-03-04T09:15:00+05:30',
    ask: 'Called 14 factory owners from the Rajkot and Ludhiana groups. 11 said missed orders are their biggest headache. 9 said they would pay if it works on WhatsApp.',
    response: '11 out of 14 with the same headache, and 9 ready to pay, is strong early signal. Keep the notes of every call; those owners are your first pilot list.',
  },
  {
    at: '2026-03-05T23:30:00+05:30',
    ask: "Honestly I'm scared. I have a stable job at Infosys, 9 years there, and my parents will freak out if I quit. Home loan EMI is 42,000 a month.",
    response: "That fear makes sense; you'd be risking a steady salary with a 42,000 EMI to cover. You don't have to jump today. Could you test the idea on weekends for a month first?",
  },
  {
    at: '2026-03-06T19:05:00+05:30',
    ask: 'Ok decided. I will build on weekends for 6 weeks. If 3 factories use it daily by mid April, I resign.',
    response: 'Clear rule: six weeks of weekends, and if three factories use it daily by mid April, you resign. That keeps the decision honest.',
  },
  // Name, co-founder, company
  {
    at: '2026-03-08T11:20:00+05:30',
    ask: 'Name idea: OrbitAI. Because in a factory everything revolves around the orders, like things in orbit. Neha liked it too.',
    response: 'OrbitAI works: everything circles around the order. Short, easy to say in any language, and Neha is on board with it.',
  },
  {
    at: '2026-03-08T11:34:00+05:30',
    ask: 'Neha Kapoor is joining as co-founder. She was my college friend from COEP, did 6 years at Razorpay in sales. She will handle customers, I will handle product and tech.',
    response: 'Neha Kapoor as co-founder for customers and sales, with you on product and tech, is a good split. Six years at Razorpay means she knows how to sell to small businesses.',
  },
  {
    at: '2026-03-11T21:10:00+05:30',
    ask: 'Neha and I discussed equity. She wanted 50/50, I proposed 60/40 since the idea and code are mine. We argued for two hours.',
    response: "Equity talks between friends are hard. Both of you have a point: the idea and code are yours, but she's bringing customers. Did you agree on anything, or is it still open?",
  },
  {
    at: '2026-03-12T08:45:00+05:30',
    ask: 'We settled it: 55/45 with 4 year vesting and a 1 year cliff for both of us. Felt relieved after.',
    response: 'Good outcome: 55/45, four-year vesting with a one-year cliff for both of you. Same terms for both keeps it fair if anything changes.',
  },
  {
    at: '2026-03-18T16:00:00+05:30',
    ask: 'OrbitAI Technologies Private Limited is incorporated today! Registered office in Pune, Baner. CIN came through this afternoon.',
    response: 'Congratulations, OrbitAI Technologies Private Limited is official as of today, 18 March, registered in Baner, Pune.',
  },
  {
    at: '2026-03-18T16:20:00+05:30',
    ask: 'Celebrated with Neha with vada pav and cutting chai at the tapri below the CA office haha',
    response: 'Vada pav and cutting chai is the perfect startup celebration. Enjoy it.',
  },
  // Building the prototype
  {
    at: '2026-03-21T14:30:00+05:30',
    ask: 'Tech decision: we will use WhatsApp Business API through Gupshup, speech to text with a Hindi and Gujarati model, and Postgres. No mobile app for now.',
    response: 'Sensible stack: WhatsApp Business API through Gupshup, speech-to-text for Hindi and Gujarati, Postgres, and no app. Owners already live in WhatsApp.',
  },
  {
    at: '2026-03-22T01:15:00+05:30',
    ask: "It's 1 am, the Gujarati voice notes are getting transcribed wrong. 'Pachas kilo' becomes 'pachas kila'. I'm so tired yaar.",
    response: "You've been at it all night. Numbers and units matter most here; a small list of common order words could correct those mistakes. Sleep first, it'll look easier tomorrow.",
  },
  {
    at: '2026-03-25T18:40:00+05:30',
    ask: 'Fixed it! Added a factory vocabulary list, 600 words like kilo, gross, MS wire, 8 gauge. Accuracy went from 71 percent to 93 percent on our 200 test notes.',
    response: 'From 71 to 93 percent on 200 test notes with a 600-word factory vocabulary. That is a big jump, nicely done.',
  },
  {
    at: '2026-03-26T10:00:00+05:30',
    ask: 'Pricing discussion with Neha. She says 4,999 a month, I think small factories will not pay more than 1,500.',
    response: "You're far apart: 4,999 versus 1,500. One way to settle it is to ask the pilot factories what one missed order costs them.",
  },
  {
    at: '2026-03-28T12:10:00+05:30',
    ask: 'Asked the pilots. One missed order costs them 8,000 to 25,000 rupees. We fixed pricing at 2,999 per month per factory, first month free.',
    response: 'Pricing is set: 2,999 rupees a month per factory, first month free. Against 8,000 to 25,000 lost per missed order, that is easy to justify.',
  },
  // First customers
  {
    at: '2026-03-30T17:25:00+05:30',
    ask: 'First pilot is live at Shree Ganesh Fasteners in Rajkot, owner Bharat bhai. He sent 23 voice orders on day one!',
    response: 'Shree Ganesh Fasteners is live, and Bharat bhai sent 23 voice orders on day one. That is exactly the daily use you were waiting for.',
  },
  {
    at: '2026-04-01T20:00:00+05:30',
    ask: 'Bharat bhai called me just to say thank you. He said for the first time in 20 years no order was missed this week. I almost cried.',
    response: "That's a moment to remember. Twenty years of missed orders, and your product fixed it in a week. That's why you started this.",
  },
  {
    at: '2026-04-03T11:45:00+05:30',
    ask: 'Two more pilots live: Mahavir Wire Products in Ludhiana and Patel Packaging in Vapi. So 3 factories using it daily now.',
    response: "Three factories using OrbitAI daily: Shree Ganesh Fasteners, Mahavir Wire Products and Patel Packaging. You've met your own rule ahead of mid April.",
  },
  {
    at: '2026-04-04T09:30:00+05:30',
    ask: 'Resigned from Infosys today. Last working day is 3 July because of the 90 day notice. Told my parents, papa was quiet, mummy was worried.',
    response: "A big step. You kept the promise you made yourself. Your father's silence and your mother's worry are natural; the three live factories are a good thing to show them.",
  },
  // Crisis
  {
    at: '2026-04-07T07:50:00+05:30',
    ask: "Disaster. Our server went down at night and we lost 2 days of orders for Mahavir Wire. They are angry, Sandeep ji said he'll stop using it. I feel like a fraud.",
    response: "That's painful, and you're not a fraud. Call Sandeep ji yourself today, rebuild the two days of orders from the WhatsApp chats, and tell him what you're changing so it won't happen again.",
  },
  {
    at: '2026-04-07T21:30:00+05:30',
    ask: "Rebuilt all 41 orders from the WhatsApp history by hand and went to Sandeep ji. He's staying, but he said one more failure and he's out.",
    response: "You recovered all 41 orders and kept Mahavir Wire. He's giving you one more chance, so reliability has to come before new features now.",
  },
  {
    at: '2026-04-08T15:00:00+05:30',
    ask: 'Lesson learned: daily backups to a second region, alerts on my phone if the server is down for 5 minutes, and we never deploy on Friday night again.',
    response: 'Good rules from a bad week: daily backups to a second region, a phone alert after 5 minutes of downtime, and no Friday night deploys.',
  },
  // Funding
  {
    at: '2026-04-09T13:00:00+05:30',
    ask: 'Meeting with Rajiv Menon from Kestrel Ventures on 14 April. Neha thinks we should raise 50 lakh, I think we need at least 75 lakh for 18 months.',
    response: "Meeting with Rajiv Menon of Kestrel Ventures on 14 April. Before then, work out the monthly burn together; it'll settle whether 50 or 75 lakh is right.",
  },
  {
    at: '2026-04-10T19:20:00+05:30',
    ask: 'Did the math. Burn is about 3.8 lakh a month with 2 hires. 18 months comes to around 68 lakh, so we will ask for 70 lakh.',
    response: 'Burn of about 3.8 lakh a month gives roughly 68 lakh for 18 months, so asking for 70 lakh is well supported.',
  },
  {
    at: '2026-04-12T23:00:00+05:30',
    ask: 'Practising the pitch. 12 slides. Opening with Bharat bhai\'s story about no missed orders in 20 years.',
    response: "Opening with Bharat bhai's story is strong: a real owner, a real result. Twelve slides is a good length.",
  },
  {
    at: '2026-04-14T18:30:00+05:30',
    ask: 'Kestrel Ventures said yes! 70 lakh pre-seed at a 5 crore post-money valuation. Rajiv wants monthly updates and a board observer seat.',
    response: 'Congratulations! Kestrel Ventures is in: 70 lakh pre-seed at a 5 crore post-money valuation, with monthly updates and a board observer seat for Rajiv.',
  },
  {
    at: '2026-04-14T18:50:00+05:30',
    ask: 'Neha was right about one thing though, Rajiv liked the customer calls more than the tech. Have to remember to give her credit.',
    response: 'Worth saying to her directly. The customer proof was her work, and saying so will keep the partnership strong.',
  },
  // Team and plans
  {
    at: '2026-04-16T11:00:00+05:30',
    ask: 'First hire offer: Arjun Rao as ML engineer, 18 lakh per annum plus 0.5 percent ESOP. He joins on 4 May.',
    response: 'Arjun Rao as your first ML engineer at 18 lakh a year plus 0.5 percent ESOP, joining on 4 May.',
  },
  {
    at: '2026-04-17T16:40:00+05:30',
    ask: 'Plan for the next 6 months: 50 paying factories by October, add Marathi and Punjabi, and build the payment reminder feature that pilots keep asking for.',
    response: 'Six-month plan: 50 paying factories by October, Marathi and Punjabi support, and the payment reminders the pilots keep asking for.',
  },
  {
    at: '2026-04-18T22:15:00+05:30',
    ask: "Some days I feel I'm not good enough to be a CEO. Neha is better at talking to people than me.",
    response: "Many first-time founders feel that. You built a product three factories use every day and won back an angry customer. Neha being good with people is why you picked her.",
  },
  {
    at: '2026-04-19T10:30:00+05:30',
    ask: 'Watched the IPL match yesterday, MI lost again haha. Needed the break though.',
    response: 'Sounds like you needed the break more than MI needed the win. Good to switch off for a night.',
  },
  {
    at: '2026-04-20T09:00:00+05:30',
    ask: 'Competitor alert: a Bangalore startup called Factoree raised 2 million dollars for factory ERP. Should I worry?',
    response: "Factoree is building an ERP, which owners must learn. OrbitAI works inside WhatsApp with voice in their own language. Keep that difference sharp and keep watching them.",
  },
  {
    at: '2026-04-21T20:45:00+05:30',
    ask: 'Decision: we will not build a dashboard for now. Owners never open laptops. Everything stays inside WhatsApp, at least until 50 factories.',
    response: 'Decided: no dashboard until 50 factories; everything stays in WhatsApp because owners never open laptops.',
  },
  {
    at: '2026-04-24T19:00:00+05:30',
    ask: 'Papa came to the office today for the first time and saw Bharat bhai\'s orders coming in live. He said "theek hai beta, accha kaam hai". Best day so far.',
    response: "That's huge. From quiet worry to 'accha kaam hai' after seeing the orders come in live. Hold on to this one.",
  },
];

/** The part of Atomic the loader needs. */
export interface StoryMemory {
  readonly size: number;
  list(limit: number): { ask: string }[];
  process(input: { ask: string; response: string; at: string }): Promise<unknown>;
}

/**
 * Pushes the story through Atomic, oldest first, each exchange with its own date. Exchanges already in memory are
 * skipped, so loading twice adds nothing. Returns how many were added.
 */
export async function loadStory(memory: StoryMemory, story: StoryExchange[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const known = new Set(memory.list(memory.size).map((experience) => experience.ask.trim()));
  let added = 0;
  for (const [index, exchange] of story.entries()) {
    if (!known.has(exchange.ask.trim())) {
      await memory.process({ ask: exchange.ask, response: exchange.response, at: new Date(exchange.at).toISOString() });
      added++;
    }
    onProgress?.(index + 1, story.length);
  }
  return added;
}
