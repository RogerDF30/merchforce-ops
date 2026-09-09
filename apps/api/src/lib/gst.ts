/** GST state codes, as GST_STATES in apps-script/Orders.gs. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam',
  '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory',
};

/** The first two digits of a GSTIN are the state code. */
export function stateCodeOf(gstin: string | null | undefined): string {
  const m = String(gstin ?? '').trim().match(/^(\d{2})/);
  return m?.[1] ?? '';
}

export function stateCodeByName(name: string | null | undefined): string {
  const k = String(name ?? '').trim().toLowerCase();
  if (!k) return '';
  for (const [code, label] of Object.entries(GST_STATES)) {
    if (label.toLowerCase() === k) return code;
  }
  return '';
}

export interface Address {
  line1: string;
  line2: string;
  city: string;
  state: string;
  pin: string;
  country: string;
}

/** Input is whatever the console sent, so every field may be absent. */
export type AddressInput = { [K in keyof Address]?: string | undefined };

export function normaliseAddress(a: AddressInput | undefined): Address {
  return {
    line1: String(a?.line1 ?? '').trim(),
    line2: String(a?.line2 ?? '').trim(),
    city: String(a?.city ?? '').trim(),
    state: String(a?.state ?? '').trim(),
    pin: String(a?.pin ?? '').trim(),
    country: String(a?.country ?? '').trim() || 'India',
  };
}

/** One-line form, as printed on a PI. */
export function addressText(a: Address): string {
  return [
    a.line1,
    a.line2,
    a.city,
    [a.state, a.pin].filter(Boolean).join(' '),
    a.country,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Loose match used to group order history by company name. */
export function companyKey(name: string | null | undefined): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,]/g, '');
}
