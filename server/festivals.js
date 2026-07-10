// Festive greeting templates for Indian real-estate agents. Dates are the next
// occurrence from mid-2026; lunar-calendar festivals shift each year, so treat
// them as suggested send dates — the agent picks the actual send time.

export const FESTIVALS = [
  {
    key: 'ganesh_chaturthi',
    name: 'Ganesh Chaturthi',
    emoji: '🐘',
    suggested_date: '2026-09-14',
    default_message:
      '🐘 Ganpati Bappa Morya, {name}! May Lord Ganesha remove every obstacle from your path and bless your family with wisdom and prosperity. Happy Ganesh Chaturthi! 🙏',
  },
  {
    key: 'onam',
    name: 'Onam',
    emoji: '🌸',
    suggested_date: '2026-08-26',
    default_message:
      '🌸 Happy Onam, {name}! May this harvest festival fill your home with joy, colours and abundance. Wishing you and your family a wonderful Thiruvonam! 🛶',
  },
  {
    key: 'navratri',
    name: 'Navratri',
    emoji: '🪩',
    suggested_date: '2026-10-11',
    default_message:
      '🪩 Happy Navratri, {name}! Nine nights of devotion, dance and new beginnings — may Maa Durga bless your home with strength and happiness. 🙏',
  },
  {
    key: 'diwali',
    name: 'Diwali',
    emoji: '🪔',
    suggested_date: '2026-11-08',
    default_message:
      '🪔 Happy Diwali, {name}! May the festival of lights bring prosperity, health and happiness to you and your family. Wishing you a sparkling new year ahead! ✨',
  },
  {
    key: 'christmas',
    name: 'Christmas',
    emoji: '🎄',
    suggested_date: '2026-12-25',
    default_message:
      '🎄 Merry Christmas, {name}! May this season bring you warmth, joy and beautiful moments with your loved ones. 🎅',
  },
  {
    key: 'new_year',
    name: 'New Year',
    emoji: '🎉',
    suggested_date: '2027-01-01',
    default_message:
      '🎉 Happy New Year, {name}! Wishing you 365 days of health, happiness and new milestones — maybe even a new home! 🏠✨',
  },
  {
    key: 'makar_sankranti',
    name: 'Makar Sankranti',
    emoji: '🪁',
    suggested_date: '2027-01-14',
    default_message:
      '🪁 Happy Makar Sankranti, {name}! May your life soar high like a kite and your home be filled with sweetness like til-gul. Til-gul ghya, god god bola! 🌞',
  },
  {
    key: 'pongal',
    name: 'Pongal',
    emoji: '🍚',
    suggested_date: '2027-01-15',
    default_message:
      '🍚 Happy Pongal, {name}! May this harvest festival overflow your home with prosperity and joy, just like the Pongal pot. Pongalo Pongal! 🌾',
  },
  {
    key: 'holi',
    name: 'Holi',
    emoji: '🎨',
    suggested_date: '2027-03-22',
    default_message:
      '🎨 Happy Holi, {name}! May your life be as colourful and joyful as the festival itself. Wishing you and your family a safe and vibrant Holi! 💦',
  },
  {
    key: 'eid',
    name: 'Eid',
    emoji: '🌙',
    suggested_date: '2027-03-10',
    default_message:
      '🌙 Eid Mubarak, {name}! May this blessed occasion bring peace, happiness and prosperity to you and your family. 🤲',
  },
]

export const getFestival = (key) => FESTIVALS.find((f) => f.key === key) || null

// Fill greeting placeholders: {name} = client name, {agent} = the sending agent.
export function personalizeGreeting(message, { name, agent } = {}) {
  return String(message || '')
    .replaceAll('{name}', name || 'ji')
    .replaceAll('{agent}', agent || '')
    .trim()
}
