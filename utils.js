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
      let address = utils
        .trimText(rawAddress)
        .replace(/[^\x20-\x7E]/g, " ")
        .replace(/\s+/g, " ");

      if (!address) {
        return "";
      }

      if (address.includes("·")) {
        const parts = address
          .split("·")
          .map((p) => utils.trimText(p))
          .filter(Boolean);
        const likelyAddress = [...parts].reverse().find((p) => /\d|,/.test(p));
        if (likelyAddress) {
          address = likelyAddress;
        }
      }

      return address;
    },

    normalizeEntry(entry) {
      const normalized = {
        name: utils.cleanName(entry.name),
        rating: utils.trimText(entry.rating),
        address: utils.cleanAddress(entry.address),
        phone: utils.cleanPhone(entry.phone),
        category: utils.trimText(entry.category).replace(/[^\x20-\x7E]/g, ""),
        description: utils.trimText(entry.description).replace(/[^\x20-\x7E]/g, ""),
        reviewsCount: utils.trimText(entry.reviewsCount)
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
        entry.description,
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
      const headers = ["name", "rating", "address", "phone", "category", "description", "reviewsCount"];
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
      return `name: ${entry.name}, phone: ${entry.phone}, category: ${entry.category}, description: ${entry.description}`;
    }
  };

  globalObj.MapsExtractorUtils = utils;
})(globalThis);
