/**
 * The approved MVP category vocabulary, as repository-owned executable configuration
 * (issue #175, implementing `ADR-021` decision 9).
 *
 * **`ADR-021` is authoritative and is not amended here.** It holds the key-to-label mapping
 * this module transcribes, and the long-form product meaning — inclusion definitions,
 * boundary notes, the tie-breaker rules and the deliberate exclusions — remains
 * authoritative in `docs/05` *The approved MVP category vocabulary*. The definitions and
 * boundary notes below are copied **verbatim** from it; nothing is paraphrased, and nothing
 * here may be edited to mean something `docs/05` does not say.
 *
 * ## The keys are governed identifiers
 *
 * The 16 machine keys were **approved once**, by Product Owner ruling on issue #167. They are
 * **not slugs recomputed from labels**: the convention that formed them — lower-case ASCII,
 * hyphen-separated, `&` and commas dropped — explains the original choice and **generates
 * nothing**. A later label change leaves its key **untouched**, and a later addition takes
 * its key from a **separately governed Product Owner decision**, never from an algorithm.
 * **No function in this module derives a key from a label**, and a test asserts that.
 *
 * ## Two executable copies, by design
 *
 * `ADR-021` accepted that the key set lives in **two** repository-owned places — this
 * configuration and the first migration's `CHECK` predicate — and required the two to be
 * **equality-tested**. That proof is `src/data/category-constraint-equality.test.ts`, which
 * compares this configuration against the **effective** constraint definitions read from the
 * PostgreSQL catalogue, in **both** directions. **No third executable list exists**: any test
 * needing the keys imports them from here.
 *
 * ## Shape
 *
 * One ordered collection of records is the single declaration; the key tuple, the
 * `CategoryKey` type and the O(1) membership lookup are all **derived from it**, so the
 * approved display order cannot drift from the approved key set. Deriving rather than
 * restating is the whole point — a second hand-written tuple would be a second source of
 * truth.
 *
 * The collection is **frozen at runtime**, not merely declared `readonly`: a `readonly`
 * annotation is erased at compile time and would leave a caller free to mutate the exported
 * objects. The membership `Set` is **private** for the same reason — exposing it would let a
 * caller add a key and widen the vocabulary at runtime, which `OQ-5` forbids by making the
 * vocabulary **configuration changed through deployment**, with no runtime management path.
 *
 * This module is plain data and pure functions: it imports nothing, performs no I/O, reads no
 * environment and is safe on both server and client.
 */

/** One approved category: its governed key and the product meaning attached to it. */
export interface Category {
  /**
   * The governed machine identifier. Stored; never derived from the label.
   *
   * Typed as the derived union rather than `string` so that a caller who takes a key from
   * this collection can assign it straight to `ListingContent.category` — a configuration
   * whose own records did not satisfy the narrowed field would be a poor configuration.
   */
  readonly key: CategoryKey;
  /** The approved user-facing display text. Never stored as identity. */
  readonly label: string;
  /** The approved inclusion definition, verbatim from `docs/05`. */
  readonly definition: string;
  /**
   * The approved boundary note, verbatim from `docs/05`.
   *
   * It records where a listing that could plausibly sit here belongs instead. `docs/05` is
   * explicit that this is *"semantic guidance for submitters and for administrator
   * correction, **not a validation rule**"* — so nothing in this repository may turn it into
   * executable logic.
   */
  readonly boundary: string;
}

/**
 * The single declaration, in the **approved alphabetical display order** (`docs/05`).
 *
 * That order is a **user-facing product decision**, and this array *is* it — there is no
 * separate order to keep in step.
 */
const CATEGORY_RECORDS = [
  {
    key: "arts-culture-entertainment",
    label: "Arts, Culture & Entertainment",
    definition:
      "Creative practice, cultural venues and performance; artists and makers selling their own work; venues and entertainment services.",
    boundary:
      "Teaching an art form as the core offering → Education & Childcare. Reselling others' goods → Retail & Shopping. Physical recreation → Fitness & Recreation.",
  },
  {
    key: "automotive-transport",
    label: "Automotive & Transport",
    definition:
      "Vehicle sale, repair, servicing and hire; driving instruction; taxi, courier, delivery, removals and freight.",
    boundary:
      "Arranging trips and stays → Travel & Accommodation. Vehicle insurance → Financial & Insurance Services. Parts retail without service → Retail & Shopping.",
  },
  {
    key: "beauty-personal-care",
    label: "Beauty & Personal Care",
    definition:
      "Hair, nails, skin, grooming and cosmetic treatment; spa and non-clinical personal treatment.",
    boundary:
      "Clinically regulated treatment → Health & Medical. Exercise and physical training → Fitness & Recreation. Product retail without treatment → Retail & Shopping.",
  },
  {
    key: "community-nonprofit",
    label: "Community & Nonprofit",
    definition:
      "Nonprofits, charities, voluntary and mutual-aid groups, community associations, public and community resources, places of worship and faith groups, support and advocacy organizations.",
    boundary:
      "Reserved for organizations whose purpose itself is community, representation or mutual support. An organization that principally trades is classified by its operational sector, not its legal form — a charity-run café is Food & Drink, a fee-charging school is Education & Childcare.",
  },
  {
    key: "education-childcare",
    label: "Education & Childcare",
    definition:
      "Schools and nurseries, childcare and after-school provision, tutoring, training, driving and music instruction, adult and vocational learning.",
    boundary:
      "Childminding offered as domestic help → Home & Trade Services. Sports coaching → Fitness & Recreation. Corporate consultancy → Professional Services.",
  },
  {
    key: "financial-insurance-services",
    label: "Financial & Insurance Services",
    definition:
      "Banking and credit, mortgage and insurance broking, financial advice and planning, pensions, bookkeeping and tax where the business presents itself as financial.",
    boundary:
      "Legal practice → Professional Services. Financial software → Technology & Digital Services. Accountancy and bookkeeping sit here rather than in Professional Services, because submitters and visitors look for them as financial.",
  },
  {
    key: "fitness-recreation",
    label: "Fitness & Recreation",
    definition:
      "Gyms and studios, sports clubs and coaching, instructor-led exercise, leisure and outdoor-activity providers.",
    boundary:
      "Clinical rehabilitation or physiotherapy → Health & Medical. Cosmetic treatment → Beauty & Personal Care. Spectator entertainment → Arts, Culture & Entertainment. Equipment retail → Retail & Shopping.",
  },
  {
    key: "food-drink",
    label: "Food & Drink",
    definition:
      "Restaurants, cafés, bars and pubs, takeaways, catering, bakeries, grocers, delicatessens, breweries, farm shops and food producers selling locally.",
    boundary:
      "A venue hired out where food is incidental → Arts, Culture & Entertainment. General stores with a food counter → Retail & Shopping. Nutrition and dietetic advice → Health & Medical. Food manufacturing or wholesale distribution → Industrial & Wholesale.",
  },
  {
    key: "health-medical",
    label: "Health & Medical",
    definition:
      "Clinical and regulated healthcare — medical and dental practice, pharmacy, optical and hearing care, physiotherapy and clinical therapies, mental-health practice, nursing and care provision.",
    boundary:
      "Deliberately narrow, so that the filter stays clinically meaningful. Cosmetic treatment → Beauty & Personal Care. Exercise provision → Fitness & Recreation. Animal health → Pets & Animal Services. Classifies the provider only — never a patient, condition or demographic.",
  },
  {
    key: "home-trade-services",
    label: "Home & Trade Services",
    definition:
      "Building, renovation and repair; the trades (plumbing, electrical, roofing, joinery, decorating); gardening and landscaping; cleaning, domestic help and property maintenance; installers and fitters.",
    boundary:
      "Property sale, letting and management → Professional Services. Materials retail without fitting → Retail & Shopping. IT support → Technology & Digital Services. Materials manufacturing or wholesale supply → Industrial & Wholesale.",
  },
  {
    key: "industrial-wholesale",
    label: "Industrial & Wholesale",
    definition:
      "Manufacturing operations; wholesale distribution; industrial services; business-supply operations not principally serving consumers through ordinary retail.",
    boundary:
      "Not a miscellaneous catch-all, and must never be used as one. Consumer-facing product shops → Retail & Shopping. Individualized consulting and knowledge work → Professional Services. Software and digital-product businesses → Technology & Digital Services. Transport operations → Automotive & Transport. Home repair and construction trades → Home & Trade Services.",
  },
  {
    key: "pets-animal-services",
    label: "Pets & Animal Services",
    definition:
      "Veterinary practice, grooming, boarding, kennels and catteries, dog walking and training, pet supplies and feed.",
    boundary:
      "Human healthcare → Health & Medical. Livestock and commercial agricultural production → Industrial & Wholesale where it is a manufacturing or wholesale operation; a farm shop selling locally is Food & Drink.",
  },
  {
    key: "professional-services",
    label: "Professional Services",
    definition:
      "Legal practice; architecture, surveying and engineering consultancy; business, marketing and HR consultancy; design and communications agencies; estate agency, letting and property management; funeral directors; other advisory and business-to-business professional practice.",
    boundary:
      "Financial and insurance advice → Financial & Insurance Services. Software and IT → Technology & Digital Services. Physical work on property → Home & Trade Services. Manufacturing, wholesale distribution and industrial supply → Industrial & Wholesale. The broadest approved category, and the first candidate for a later governed additive split.",
  },
  {
    key: "retail-shopping",
    label: "Retail & Shopping",
    definition:
      "Shops and physical retail of goods; online sellers of physical products; markets and stalls; secondhand, antique and charity retail; specialist and gift retail.",
    boundary:
      "A named sector category takes precedence over general retail: food and drink → Food & Drink; pet supplies → Pets & Animal Services. Goods sold incidentally alongside a service → the service's category. Wholesale and business supply rather than consumer sale → Industrial & Wholesale.",
  },
  {
    key: "technology-digital-services",
    label: "Technology & Digital Services",
    definition:
      "Software development, web and app development, IT support and managed services, hosting, data and digital consultancy, and digital marketing where the offering is technical.",
    boundary:
      "Device and hardware retail → Retail & Shopping. Non-technical business consultancy → Professional Services. Hardware manufacturing or wholesale distribution → Industrial & Wholesale. Repair of consumer devices may truthfully sit here or in Retail & Shopping, decided by the principal offering.",
  },
  {
    key: "travel-accommodation",
    label: "Travel & Accommodation",
    definition:
      "Hotels, guest houses, bed and breakfast, self-catering and short-stay accommodation; campsites; travel agents and tour operators; local tours and guides.",
    boundary:
      "Passenger transport, taxis and vehicle hire → Automotive & Transport. Hospitality without accommodation → Food & Drink. Visitor attractions → Arts, Culture & Entertainment.",
  },
] as const;

/**
 * The governed machine keys, as an exact literal union.
 *
 * Derived from the single declaration above, so the type cannot disagree with the data. This
 * is the same shape `status.ts` uses for `ListingStatus`, which is what `ADR-021` decision 9
 * means by *"on the `status.ts` shape"*.
 */
export type CategoryKey = (typeof CATEGORY_RECORDS)[number]["key"];

/**
 * The 16 approved categories, in the approved display order.
 *
 * Frozen, records included, so a caller cannot reorder the vocabulary or edit a label at
 * runtime.
 */
export const CATEGORIES: readonly Category[] = Object.freeze(
  CATEGORY_RECORDS.map((record) => Object.freeze({ ...record })),
);

/** The approved keys in display order, derived from {@link CATEGORIES}. */
export const CATEGORY_KEYS: readonly CategoryKey[] = Object.freeze(
  CATEGORY_RECORDS.map((record) => record.key),
);

/**
 * Private membership index. **Not exported**: a caller holding this `Set` could `add` a key
 * and widen the vocabulary at runtime, which `OQ-5` forbids.
 */
const KEYS = new Set<string>(CATEGORY_KEYS);

/** Private key-to-category index, for O(1) lookup without exposing a mutable `Map`. */
const BY_KEY = new Map<string, Category>(
  CATEGORIES.map((category) => [category.key, category]),
);

/**
 * Is `candidate` one of the 16 approved machine keys?
 *
 * The one membership predicate in the repository. `DI-9` (a category value always references
 * a member of the predefined set) and `AV-7` (category values are validated against the
 * predefined set) are the same rule stated at two altitudes, so they share this
 * implementation rather than getting two.
 *
 * It takes `unknown` because the values it must refuse arrive from untrusted boundaries,
 * casts and rehydrated records — places a compile-time type guarantees nothing. **Narrowing
 * `ListingContent.category` does not make this redundant**; both are required
 * (`ADR-019`: *"boundary validation and database constraints remain mandatory"*).
 *
 * **Nothing is normalized.** A padded, mis-cased or label-shaped value is **refused**, not
 * repaired: `OQ-5` admits no aliases and `VR-S3` leaves format expression undecided, so
 * trimming or case-folding here would invent a rule nobody governed.
 */
export function isCategoryKey(candidate: unknown): candidate is CategoryKey {
  return typeof candidate === "string" && KEYS.has(candidate);
}

/**
 * The approved category for `key`, or `undefined` if there is none.
 *
 * Returns the frozen record. An unknown key yields `undefined` and **extends nothing** — the
 * lookup cannot grow the vocabulary.
 */
export function categoryFor(key: unknown): Category | undefined {
  return typeof key === "string" ? BY_KEY.get(key) : undefined;
}
