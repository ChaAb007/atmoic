/**
 * Reference sentences for the vector checks. Each sub-layer that is judged by meaning compares a piece's
 * vector with these examples (English, Hindi and Hinglish). They are embedded once per embedder and cached.
 * Novelty, trust and situation are judged against memory instead, and correctness against the ask itself.
 */

export type AnchorSet =
  | 'facts'
  | 'intelligence'
  | 'intent'
  | 'decision'
  | 'commitment'
  | 'time'
  | 'pressure'
  | 'risk'
  | 'relationship'
  | 'emotionPositive'
  | 'emotionNegative'
  | 'engaged'
  | 'disengaged'
  | 'failure'
  | 'correction'
  | 'neutral';

export const ANCHORS: Record<AnchorSet, string[]> = {
  facts: [
    'The order is 500 pieces at 78 rupees per kg',
    'Invoice number 1041 is for 2.34 lakh rupees',
    'AVI Enterprise is located in Pune',
    'My birthday is on 12 March',
    'We have 3 machines and 50 workers in the factory',
    'Delivery address is Sector 18, Noida',
    'bill 45 hazaar ka bana hai, GST alag se',
    'उसका फोन नंबर 98765 43210 है',
    'The discount applied is 3 percent on the total',
  ],
  intelligence: [
    'The reason it rusted is humid storage and a thin oil coating',
    'To do this, first open the sheet, then apply the formula to each row',
    'The lesson here is to always check the vehicle number before the e-way bill',
    'If we buy wire rod before the price hike we save money',
    'isliye pehle stock check karna chahiye, warna order atak jata hai',
    'इसका कारण यह है कि मांग अचानक बढ़ गई',
    'Here is how compound interest works over three years',
    'Because the supplier is often late, splitting orders between two suppliers reduces risk',
  ],
  intent: [
    'I want to place a new order',
    'Please make the invoice for AVI Enterprise',
    'Can you help me write an email to the customer',
    'Fill in the details for the new order in the excel sheet',
    'mujhe ek report chahiye is mahine ki',
    'मुझे नया ऑर्डर बनाना है',
    'I need the latest price list',
    'Send me the details of the payment',
  ],
  decision: [
    'We decided to give a 3 percent discount',
    'Final hai, Monday ko dispatch karenge',
    "Let's go with the cheaper supplier",
    'I approve the new rate',
    'हमने फैसला किया है कि रेट नहीं बढ़ाएंगे',
    'Okay, we will not extend credit to them',
    'The boss agreed to the plan',
    'Cancel the order, we are not going ahead',
  ],
  commitment: [
    'I will pay by Friday',
    "I'll send the report tomorrow",
    'kal tak bhej dunga, pakka',
    'मैं सोमवार तक पेमेंट कर दूंगा',
    'We promise delivery by the 10th',
    'Okay sir, I will do it today',
    "I'll call you back in an hour",
    'Consider it done, I will make sure it happens',
  ],
  time: [
    'by tomorrow morning',
    'the deadline is 15 October',
    'next Monday at 11',
    'kal tak, ya parson',
    'आज शाम तक',
    'in two hours',
    'every month on the first',
    'Diwali se pehle chahiye',
  ],
  pressure: [
    'This is very urgent, do it right now',
    'The boss is angry, it must be done today',
    'The customer is waiting, hurry up',
    'jaldi karo bhai, abhi chahiye',
    'अभी के अभी चाहिए, देर नहीं होनी चाहिए',
    'No more delays or we lose the order',
    'I need it as soon as possible',
    'Deadline is today, no excuses',
  ],
  risk: [
    'If we miss this we will lose the customer',
    'This could cost us a lot of money',
    'There is a risk the cheque bounces',
    'warna penalty lagegi aur order cancel ho jayega',
    'अगर देर हुई तो बहुत नुकसान होगा',
    'Be careful, the machine may break down',
    'This could become a legal problem',
    'If the discount is wrong we lose margin on the whole order',
  ],
  relationship: [
    'The boss ordered this',
    'Sir told me to do it',
    'malik ne bola hai, karna padega',
    "As per the owner's instruction",
    'मेरे मैनेजर ने कहा है',
    'My customer asked for it personally',
    'Our supplier said they cannot deliver',
    'On behalf of the director',
  ],
  emotionPositive: [
    "I'm so happy with this",
    'Thank you so much, great job',
    'bahut badhiya, maza aa gaya',
    'बहुत खुशी हुई यह सुनकर',
    "That's wonderful news",
    'I love it, perfect',
    'Haha that is so funny',
    'I am proud of the team',
  ],
  emotionNegative: [
    "I'm really upset about this",
    'This is so frustrating',
    "I'm worried about the payment",
    'bahut gussa aa raha hai',
    'मैं बहुत परेशान हूँ',
    "I'm tired and stressed today",
    'This is terrible service',
    'I feel sad and alone',
  ],
  engaged: [
    "Tell me more about this, it's interesting",
    'Wait, explain that part again',
    'Really? What happened next?',
    'acha, aur batao',
    'यह दिलचस्प है, विस्तार से बताओ',
    'I have a follow-up question on that',
    "Let's go deeper into this",
  ],
  disengaged: [
    'hmm ok',
    'whatever',
    'fine',
    'k',
    'theek hai',
    'chhodo',
    'never mind',
    'ठीक है',
  ],
  failure: [
    "Sorry, I couldn't do that",
    'There was an error',
    "I don't know",
    "I'm not sure about this",
    'nahi ho paya',
    'मुझसे यह नहीं हो पाया',
    'That information is not available to me',
    'Failed to create the file',
  ],
  correction: [
    "No, that's wrong",
    "That's not what I asked",
    'galat hai yeh',
    'यह गलत है',
    'You misunderstood me',
    'Not correct, try again',
    'nahi yaar, aisa nahi',
  ],
  neutral: [
    'hello',
    'hi there',
    'how are you',
    'kya haal hai',
    'नमस्ते',
    'good morning',
    'okay',
    'nice weather today',
    "what's up",
  ],
};

/** Stable fingerprint of the anchor sentences, so a cached embedding is reused only when they are unchanged. */
export function anchorsFingerprint(anchors: Record<string, string[]> = ANCHORS): string {
  let hash = 2166136261;
  const text = JSON.stringify(anchors);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
