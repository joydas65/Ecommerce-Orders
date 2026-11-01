import { catalog } from './catalog.js';
import { ApiError, invalid } from './errors.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && uuidPattern.test(value);
export const isEntityId = (value, prefix) => typeof value === 'string' && value.startsWith(`${prefix}_`) && isUuid(value.slice(prefix.length + 1));

export function guestIdentity(value) {
  if (!isUuid(value)) throw new ApiError(401, 'GUEST_REQUIRED', 'A guest session is required.');
  return value.toLowerCase();
}

function objectFields(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const keys = Object.keys(value);
  if (!required.every((key) => Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) throw invalid();
}

export function quoteInput(input) {
  objectFields(input, ['items', 'shippingMethod', 'destination']);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 6) throw invalid();
  if (!['demo-standard', 'demo-express'].includes(input.shippingMethod)) throw invalid();
  objectFields(input.destination, ['country'], ['region']);
  const { country, region = '' } = input.destination;
  if (!['US', 'GB', 'SG'].includes(country) || (country === 'US' ? !['CA', 'NY', 'TX'].includes(region) : region !== '')) throw invalid();
  const seen = new Set();
  const items = input.items.map((item) => {
    objectFields(item, ['productId', 'quantity']);
    if (typeof item.productId !== 'string' || !Object.hasOwn(catalog, item.productId) || seen.has(item.productId)) throw invalid();
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw invalid();
    seen.add(item.productId);
    const product = catalog[item.productId];
    return { productId: item.productId, name: product.name, quantity: item.quantity, unitPriceCents: product.cents, lineTotalCents: product.cents * item.quantity };
  });
  const shippingCents = input.shippingMethod === 'demo-standard' ? 500 : 1200;
  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const taxCents = Math.round((subtotalCents + shippingCents) * 8 / 100);
  return { currency: 'USD', items, shippingMethod: input.shippingMethod, shippingCents, subtotalCents, taxCents, totalCents: subtotalCents + shippingCents + taxCents, pricingVersion: 'demo-v1' };
}

export function submissionInput(input, key) {
  objectFields(input, ['quoteId']);
  if (!isEntityId(input.quoteId, 'quote') || !isUuid(key)) throw invalid();
  return { quoteId: input.quoteId.toLowerCase(), key: key.toLowerCase() };
}
