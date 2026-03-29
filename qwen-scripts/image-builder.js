function buildImageQuery({ title, section, tags }) {
  const base = `${title} news`;
  const tagPart = (tags || []).slice(0, 2).join(' ');
  return `${base} ${tagPart} editorial photo`;
}

function buildAlt({ title }) {
  return `${title} – news illustration`;
}

module.exports = { buildImageQuery, buildAlt };
