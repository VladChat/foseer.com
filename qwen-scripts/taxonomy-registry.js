function overrideSectionByTitle(title, section) {
  if (/nba|mlb|nfl|league/i.test(title)) {
    return 'Sports';
  }
  return section;
}

module.exports = { overrideSectionByTitle };
