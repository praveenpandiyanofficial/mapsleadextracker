/* global globalThis */
(function bootstrapUtils(globalObj) {
  const utils = {
    trimText(value) {
      if (value === null || value === undefined) {
        return "";
      }
      return String(value).replace(/\s+/g, " ").trim();
    },

    cleanPhone(rawPhone) {
      let phone = utils.trimText(rawPhone);
      if (!phone) {
        return "";
      }

      phone = phone.replace(/[^\d+]/g, "");
      phone = phone.replace(/^\+91/, "");
      phone = phone.replace(/^0+/, "");

      return phone.replace(/\s+/g, "");
    },

    cleanName(rawName) {
      const name = utils
        .trimText(rawName)
        .replace(/[^\x20-\x7E]/g, " ")
        .replace(/\s+/g, " ");

      if (!name) {
        return "";
      }

      const invalid = new Set(["results", "result", "google maps"]);
      if (invalid.has(name.toLowerCase())) {
        return "";
      }

      return name;
    },

    cleanAddress(rawAddress) {
      let address = utils.trimText(rawAddress);

      if (!address) {
        return "";
      }

      // Split on "·" (U+00B7) BEFORE stripping non-ASCII, otherwise the dot is
      // gone and we end up keeping "Jewelry store 29, N Usman Rd".
      // Also handle the middle-dot variant "•" and the bullet "‧".
      const SEP = /[\u00B7\u2022\u2027]/;
      if (SEP.test(address)) {
        const parts = address
          .split(SEP)
          .map((p) => utils.trimText(p))
          .filter(Boolean);
        // Prefer the part that contains a digit or comma (likely the address).
        const likelyAddress = [...parts].reverse().find((p) => /\d|,/.test(p));
        if (likelyAddress) {
          address = likelyAddress;
        }
      }

      // Now strip remaining non-ASCII (icons, etc.) and collapse spaces.
      address = address
        .replace(/[^\x20-\x7E]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Drop a leading category-like word that wasn't separated by "·"
      // e.g. "Jewelry store 29, N Usman Rd" -> "29, N Usman Rd".
      const leadingMatch = address.match(/^([A-Za-z][A-Za-z &/-]+?)\s+(\d.*)$/);
      if (leadingMatch && /\b(store|shop|market|bakery|cafe|restaurant|hotel|supermarket|mall|pharmacy|salon|gym|studio|jeweller(?:s|y)|jewellers|boutique|showroom|outlet|center|centre|services?)\b/i.test(leadingMatch[1])) {
        address = leadingMatch[2];
      }

      return address;
    },

    cleanWebsite(rawWebsite) {
      const value = utils.trimText(rawWebsite).replace(/[^\x20-\x7E]/g, "");
      if (!value) {
        return "No website";
      }
      return value;
    },

    cleanOpeningHours(rawHours) {
      const value = utils.trimText(rawHours).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
      return value || "Hours not listed";
    },

    normalizeEntry(entry) {
      const normalized = {
        name: utils.cleanName(entry.name),
        address: utils.cleanAddress(entry.address),
        phone: utils.cleanPhone(entry.phone),
        website: utils.cleanWebsite(entry.website),
        openingHours: utils.cleanOpeningHours(entry.openingHours),
        category: utils.trimText(entry.category).replace(/[^\x20-\x7E]/g, "")
      };

      if (!normalized.phone || !normalized.name) {
        return null;
      }

      return normalized;
    },

    dedupeEntries(entries) {
      const seen = new Set();
      const output = [];

      for (const item of entries) {
        const normalized = utils.normalizeEntry(item);
        if (!normalized) {
          continue;
        }

        const key = `${normalized.phone}|${normalized.name.toLowerCase()}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        output.push(normalized);
      }

      return output;
    },

    matchesCategory(entry, filter) {
      const normalizedFilter = utils.trimText(filter).toLowerCase();
      if (!normalizedFilter) {
        return true;
      }

      if (/\bnear\s*me\b|\bnear\s*by\b/.test(normalizedFilter)) {
        return true;
      }

      const haystack = [
        entry.category,
        entry.name,
        entry.address
      ]
        .map((v) => utils.trimText(v).toLowerCase())
        .join(" ");

      const groups = normalizedFilter
        .split(/[,\|]/)
        .map((group) => group.trim())
        .filter(Boolean);

      if (groups.length === 0) {
        return true;
      }

      // OR between comma-separated groups, AND between words in each group.
      return groups.some((group) => {
        const words = group.split(/\s+/).filter(Boolean);
        return words.every((word) => haystack.includes(word));
      });
    },

    toCSV(entries) {
      const headers = ["name", "address", "phone", "website", "openingHours", "category"];
      const escapeCell = (value) => {
        const text = utils.trimText(value);
        const escaped = text.replace(/"/g, "\"\"");
        return `"${escaped}"`;
      };

      const rows = [
        headers.join(","),
        ...entries.map((entry) => headers.map((key) => escapeCell(entry[key])).join(","))
      ];

      return rows.join("\n");
    },

    toPrettyLine(entry) {
      const safe = (value, fallback = "") => {
        if (value === null || value === undefined) {
          return fallback;
        }
        const text = String(value).trim();
        return text || fallback;
      };

      return [
        `name: ${safe(entry.name, "Unknown")}`,
        `address: ${safe(entry.address, "Address not listed")}`,
        `phone: ${safe(entry.phone, "No phone")}`,
        `website: ${safe(entry.website, "No website")}`,
        `openingHours: ${safe(entry.openingHours, "Hours not listed")}`,
        `category: ${safe(entry.category, "")}`
      ].join(", ");
    }
  };

  globalObj.MapsExtractorUtils = utils;
})(globalThis);
