javascript:(function () {
  // source DOI has to be identified
  sourceDOI = document.querySelector('meta[name=\'citation_doi\']') || document.querySelector('meta[name=\'evt-doiPage\']') || document.querySelector('meta[scheme=\'doi\']') || document.querySelector('meta[name=\'prism.doi\']')
  if (!sourceDOI) return (alert('Unfortunately could not extract source DOI.'))
  else sourceDOI = sourceDOI.content.toUpperCase()

  // onlinelibrary.wiley.com
  lis = document.querySelectorAll('#references-section ul > li')
  // nature.com
  if (!lis.length) lis = document.querySelectorAll('ol.c-article-references > li')
  // pnas.org / sciencemag.org / jimmunol.org / biorxiv.org
  if (!lis.length) lis = document.querySelectorAll('ol.cit-list > li')
  // frontiersin.org
  if (!lis.length) lis = document.querySelectorAll('div.References')
  // nejm.org
  if (!lis.length) lis = document.querySelectorAll('ol#referenceContent > li')
  // amjpathol.org
  if (!lis.length) lis = document.querySelectorAll('ol.referenceList > li')
  // oup.com
  if (!lis.length) lis = document.querySelectorAll('.ref-list .ref')
  // plos.org
  if (!lis.length) lis = document.querySelectorAll('.references > li')
  // cell.com / thelancet.com
  if (!lis.length) lis = document.querySelectorAll('li.ref')
  // sagepub.com
  if (!lis.length) lis = document.querySelectorAll('table.references tr')
  // JMIR
  if (!lis.length) lis = document.querySelectorAll('.footnotes > ol > li')
  // sciencedirect.com
  if (!lis.length) lis = document.querySelectorAll('.reference')
  // science.org
  if (!lis.length) lis = document.querySelectorAll('#bibliography .citation')
  // pubmed.ncbi.nlm.nih.gov - fetch pmid
  if (!lis.length) lis = document.querySelectorAll('ol#top-references-list-1 > li')
  // IEEE
  if (!lis.length) lis = document.querySelectorAll('.text-base-md-lh div.reference-container')

  listOfReferences = Array.from(lis).map(x => {
    // Regular expression adapted from Crossref's recommendation (https://www.crossref.org/blog/dois-and-matching-regular-expressions/)
    // Using the set [-_;()/:A-Z0-9] twice (fullstop . and semicolon ; only in first set) makes sure that the trailing character is neither a fullstop nor semicolon
    id = decodeURIComponent(encodeURIComponent(x.innerHTML)).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+[-_()/:A-Z0-9]+/gi)
    if (id) {
      // Make sure DOI fetched for this reference is not sourceDOI
      return (id && id.map(id => id.toUpperCase()).filter(id => id !== sourceDOI)[0])
      // If no DOI try PMID
    } else {
      // Try to get PMID from pubmed itself
      pubmed_a = x.querySelectorAll('a.reference-link:not([href*=\'pmc\'])')
      if (pubmed_a.length && pubmed_a[0].attributes['data-ga-action']) {
        id = pubmed_a[0].attributes['data-ga-action'].value
        // Try to fetch PMID from other pages
      } else {
        a = x.querySelectorAll('a[href*=\'ncbi.nlm.nih.gov\']:not([href*=\'pmc\'])')
        if (a.length) id = a[0].attributes.href.value.match(/\d+/g)[0]
      }
      if (id) return ('pmid:' + id)
    }
  })

  if (listOfReferences.length) {
    window.open('https://LocalCitationNetwork.github.io?source=' + sourceDOI + '&listOfIds=' + listOfReferences.join(',') + '&bookmarkletURL=' + document.URL)
  } else {
    alert('Unfortunately could not extract references.')
  }
}())
