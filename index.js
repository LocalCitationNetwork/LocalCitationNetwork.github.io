/* Local Citation Network (GPL-3) */
/* by Tim Woelfle */
/* https://LocalCitationNetwork.github.io */

/* global fetch, localStorage, vis, Vue, Buefy */

'use strict'

const localCitationNetworkVersion = 1.24

/*
For now, old terminology is kept in-code because of back-compatibility with old saved graphs objects (localStorage & JSON)
"incomingSuggestions" are now "topReferences"
"outgoingSuggestions" are now "topCitations"
*/

const arrSum = arr => arr.reduce((a, b) => a + b, 0)
const arrAvg = arr => arrSum(arr) / arr.length

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze#examples
function deepFreeze (object) {
  if (typeof object !== 'object') return object

  for (const name of Reflect.ownKeys(object)) {
    const value = object[name]

    if ((value && typeof value === 'object') || typeof value === 'function') {
      deepFreeze(value)
    }
  }

  return Object.freeze(object)
}

/* Semantic Scholar API */
// https://api.semanticscholar.org/api-docs/graph#tag/paper

async function semanticScholarWrapper (ids, responseFunction, phase, retrieveAllReferences = false, retrieveAllCitations = false, getReferenceContexts = false) {
  let responses = []

  ids = ids.map(id => {
    if (!id) return undefined
    else if (!isNaN(id)) return 'pmid:' + id
    else return id
  })

  let selectFields = 'title,venue,year,externalIds,abstract,referenceCount,citationCount,publicationTypes,publicationDate,journal'

  // Use "references" / "citations" API endpoints instead of a a single query for each reference / citation for "Retrieve references / citations: All" (faster)
  if ((phase === 'references' && retrieveAllReferences) || (phase === 'citations' && retrieveAllCitations)) {
    let offset, response

    // Cannot get author affiliations and external IDs (e.g. ORCID) on references / citations endpoints
    selectFields += ',authors'

    ids = ids.filter(Boolean)
    vm.isLoadingTotal = ids.length
    for (const i of Array(ids.length).keys()) {
      const id = ids[i]
      response = undefined
      vm.isLoadingIndex = i
      offset = 0
      while (offset !== undefined) {
        response = await semanticScholarPaper(id + '/' + phase + '?limit=1000&offset=' + offset + '&fields=' + selectFields, { headers: { 'x-api-key': vm.semanticScholarAPIKey } })
        offset = response.next
        response = response.data.map(x => x.citedPaper || x.citingPaper) // citedPaper for references, citingPaper for citations
        // Semantic Scholar doesn't provide references & citations lists for citations & references endpoint
        // That's why for S2: All Citations always only have one reference and All References only have one citation (the one that called them), which are merged in responseToArray during de-duplication
        // response can be null in case of placeholders in id-list
        if (phase === 'citations' && response) {
          response = response.map(x => { x.references = [{ paperId: id }]; return x })
        }
        // This is not needed, as computed.referencedCiting only relies on references arrays
        /* else { // must be (phase === 'references')
          response = response.map(x => { x.citations = [{ paperId: id }]; return x })
        } */
        responses = responses.concat(response)
      }
    }
  // Phase 'source' / 'input' / 'references' && !retrieveAllReferences (i.e. Top references only) / 'citations' && !retrieveAllCitations (i.e. Top Citations only)
  } else {
    // These fields cannot be retrieved on references / citations endpoints
    selectFields += ',authors.externalIds,authors.name,authors.affiliations,references.paperId,tldr'
    // Get citations ids for input articles (if not all citations are retrieved anyway)
    if (['source', 'input'].includes(phase) && !retrieveAllCitations) selectFields += ',citations.paperId'

    // Batch endpoint allows max. 500 ids at the same time
    responses = await semanticScholarPaper('batch?fields=' + selectFields, { method: 'POST', headers: { 'x-api-key': vm.semanticScholarAPIKey }, body: JSON.stringify({ ids: ids.filter(Boolean) }) })
    // Get referenceContexts for source
    if (phase === 'source' && getReferenceContexts) {
      const referenceContexts = await semanticScholarPaper(ids[0] + '/references?limit=1000&fields=paperId,contexts')
      if (referenceContexts) responses[0].referenceContexts = referenceContexts
    }
    // Add placeholders for missing items from batch response
    // ?. because empty batch API call (e.g. "Retrieve references: None") doesn't return array
    responses = responses?.map((e, i) => (e === null) ? { title: 'Missing: ' + ids[i] + ' (id not found in S2)' } : e)
  }

  // Some S2 responses don't have S2 ids, remove them for now
  // responses = responses.filter(response => response?.paperId)

  vm.isLoadingTotal = 0
  responseFunction(responses)
}

function semanticScholarPaper (suffix, init = undefined) {
  return fetch('https://api.semanticscholar.org/graph/v1/paper/' + suffix, init).then(response => {
    if (!response.ok) throw (response)
    return response.json()
  }).catch(async function (response) {
    // "Too Many Requests" errors (status 429) are unfortunately sometimes sent with wrong CORS header and thus cannot be distinguished from generic network errors
    if (response.status === 429 || typeof response.statusText !== 'string') {
      if (response.status === 429) vm.errorMessage('Semantic Scholar (S2) reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('Semantic Scholar (S2) not reachable, probably too rapid requests. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return semanticScholarPaper(suffix, init)
    }
    const id = suffix.replace(/\?.*/, '')
    vm.errorMessage('Error while processing data through Semantic Scholar API for ' + id + ': ' + response.statusText + ' (' + response.status + ')')
    // Add placeholders for missing items with reason
    return { title: 'Missing: ' + id + ' (' + response.statusText + ', ' + response.status + ')' }
  })
}

function semanticScholarResponseToArticleArray (data) {
  return data.filter(Boolean).map(article => {
    const doi = article.externalIds?.DOI?.toUpperCase()

    return {
      id: article.paperId,
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      type: article.publicationTypes,
      title: article.title || '',
      authors: (article.authors || []).map(author => {
        const cutPoint = (author.name.lastIndexOf(',') !== -1) ? author.name.lastIndexOf(',') : author.name.lastIndexOf(' ')
        return {
          id: author.authorId,
          orcid: author.externalIds?.ORCID,
          url: author.url,
          LN: author.name.substr(cutPoint + 1),
          FN: author.name.substr(0, cutPoint),
          affil: (author.affiliations || []).join(', ') || undefined
        }
      }),
      year: article.year,
      date: article.publicationDate,
      journal: article.journal?.name || article.venue,
      volume: article.journal?.volume?.trim(),
      firstPage: article.journal?.pages?.split('-')?.[0]?.trim(),
      lastPage: article.journal?.pages?.split('-')?.[1]?.trim(),
      references: article.references?.map(x => x.paperId),
      referencesCount: article.referenceCount,
      citations: article.citations?.map(x => x.paperId).filter(Boolean),
      citationsCount: article.citationCount,
      abstract: article.abstract,
      tldr: article.tldr?.text,
      referenceContexts: article.referenceContexts && Object.fromEntries(article.referenceContexts.data.filter(x => x.citedPaper.paperId).map(x => [x.citedPaper.paperId, x.contexts]))
    }
  })
}

/* OpenAlex API */
// https://docs.openalex.org/about-the-data/work#the-work-object

async function openAlexWrapper (ids, responseFunction, phase, retrieveAllReferences = false, retrieveAllCitations = false) {
  let responses = []
  ids = ids.map(id => {
    if (!id) return undefined
    // OpenAlex usually formats ids as URLs (e.g. https://openalex.org/W2741809807 / https://doi.org/10.7717/peerj.4375 / https://pubmed.ncbi.nlm.nih.gov/29456894)
    // Supported ids: https://docs.openalex.org/api-entities/works/work-object#id
    else if (id.includes('https://')) return id
    else if (id.toLowerCase().match(/doi:|mag:|openalex:|pmid:|pmcid:/)) return id.toLowerCase()
    else if (id.includes('/')) return 'doi:' + id
    else if (!isNaN(id)) return 'pmid:' + id
    else return 'openalex:' + id
  })

  const selectFields = 'id,doi,title,authorships,publication_year,primary_location,biblio,referenced_works,cited_by_count,abstract_inverted_index,is_retracted,type,publication_date'

  let id, cursor, response

  // Use "filter" API endpoint instead of a a single query for each reference / citation for "Retrieve references / citations: All" (faster)
  if ((phase === 'references' && retrieveAllReferences) || (phase === 'citations' && retrieveAllCitations)) {
    // OpenAlex API allows OR combination of up to 50 IDs: https://docs.openalex.org/how-to-use-the-api/get-lists-of-entities/filter-entity-lists
    const max = Math.ceil(ids.filter(Boolean).length / 50)
    let idsString
    vm.isLoadingTotal = max
    for (const i of Array(max).keys()) {
      idsString = ids.filter(Boolean).slice(i * 50, (i + 1) * 50).map(x => x.replace('openalex:', '')).join('|')
      response = undefined
      vm.isLoadingIndex = i

      // Cursor paging allows getting all records (up to 200 per API call): https://docs.openalex.org/how-to-use-the-api/get-lists-of-entities/paging
      cursor = '*'
      while (cursor) {
        response = await openAlexWorks('?select=' + selectFields + '&per-page=200&sort=referenced_works_count:desc&filter=' + ((phase === 'references') ? 'cited_by' : 'cites') + ':' + idsString + '&cursor=' + cursor)
        cursor = response.meta.next_cursor
        if (response.results?.length) responses = responses.concat(response.results)
      }
    }
  // Phase 'source' / 'input' / 'references' && !retrieveAllReferences (i.e. Top references only) / 'citations' && !retrieveAllCitations (i.e. Top Citations only)
  } else {
    vm.isLoadingTotal = ids.length
    for (const i of Array(ids.length).keys()) {
      id = ids[i]
      response = undefined
      vm.isLoadingIndex = i
      if (id) {
        response = await openAlexWorks('/' + id.replace('openalex:', '') + '?select=' + selectFields)
        // Get citations ids for input articles (if not all citations are retrieved anyway)
        if (['source', 'input'].includes(phase) && response.id && !retrieveAllCitations) {
          // Careful: Citation results are incomplete when a paper is cited by >200 (current per-page upper-limit of OA), use "API options => Retrieve citations => All" for completeness
          const citations = await openAlexWorks('?select=id&per-page=200&sort=referenced_works_count:desc&filter=cites:' + response.id.replace('https://openalex.org/', ''))
          if (citations) { response.citations = citations }
        }
      }
      responses.push(response)
    }
  }
  vm.isLoadingTotal = 0
  responseFunction(responses)
}

function openAlexWorks (suffix) {
  return fetch('https://api.openalex.org/works' + suffix + '&mailto=local-citation-network@timwoelfle.de').then(response => {
    if (!response.ok) throw (response)
    return response.json()
  }).catch(async function (response) {
    if (response.status === 429 || typeof response.statusText !== 'string') {
      if (response.status === 429) vm.errorMessage('OpenAlex (OA) reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('OpenAlex (OA) not reachable. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return openAlexWorks(suffix)
    }
    const id = suffix.substr(1).replace(/\?.*/, '')
    vm.errorMessage('Error while processing data through OpenAlex API for ' + id + ': ' + response.statusText + ' (' + response.status + ')')
    // Add placeholders for missing items with reason
    return { title: 'Missing: ' + id + ' (' + response.statusText + ', ' + response.status + ')' }
  })
}

function openAlexResponseToArticleArray (data) {
  return data.filter(Boolean).map(article => {
    const doi = (article.doi) ? article.doi.replace('https://doi.org/', '').toUpperCase() : undefined

    let journal = article.primary_location?.source?.display_name
    if (article.primary_location?.source?.host_organization_name && !article.primary_location?.source?.title?.includes(article.primary_location.source?.host_organization_name)) { journal += ' (' + article.primary_location?.source?.host_organization_name + ')' }

    return {
      id: article.id?.replace('https://openalex.org/', ''),
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      type: article.type,
      title: article.title || '',
      authors: (article.authorships || []).map(authorship => {
        const display_name = authorship.author.display_name || ''
        const cutPoint = (display_name.lastIndexOf(',') !== -1) ? display_name.lastIndexOf(',') : display_name.lastIndexOf(' ')
        return {
          id: authorship.author.id?.replace('https://openalex.org/', ''),
          orcid: authorship.author.orcid?.replace('https://orcid.org/', ''),
          LN: display_name.substr(cutPoint + 1),
          FN: display_name.substr(0, cutPoint),
          affil: (authorship.institutions || []).map(institution => institution.display_name + (institution.country_code ? ' (' + institution.country_code + ')' : '')).join(', ') || undefined
        }
      }),
      year: article.publication_year,
      date: article.publication_date,
      journal: journal,
      volume: article.biblio?.volume,
      issue: article.biblio?.issue,
      firstPage: article.biblio?.first_page,
      lastPage: article.biblio?.last_page,
      references: article.referenced_works?.map(x => x.replace('https://openalex.org/', '')),
      referencesCount: article.referenced_works?.length,
      citations: article.citations?.results.map(x => x.id.replace('https://openalex.org/', '')),
      citationsCount: article.cited_by_count,
      abstract: (article.abstract_inverted_index) ? revertAbstractFromInvertedIndex(article.abstract_inverted_index) : undefined,
      isRetracted: article.is_retracted
    }
  })
}

function revertAbstractFromInvertedIndex (abstract_inverted_index) {
  const abstract = []
  Object.keys(abstract_inverted_index).forEach(word => abstract_inverted_index[word].forEach(i => { abstract[i] = word }))
  return abstract.join(' ').replaceAll('  ', ' ').trim()
}

/* Crossref API */
// https://github.com/CrossRef/rest-api-doc#api-overview

async function crossrefWrapper (ids, responseFunction, phase) {
  const responses = []
  vm.isLoadingTotal = ids.length
  for (const i of Array(ids.length).keys()) {
    let response
    vm.isLoadingIndex = i
    if (ids[i]) response = await crossrefWorks(ids[i])
    responses.push(response)
  }
  vm.isLoadingTotal = 0
  responseFunction(responses)
}

function crossrefWorks (id) {
  return fetch('https://api.crossref.org/works?filter=doi:' + id + '&select=DOI,title,author,issued,container-title,reference,is-referenced-by-count,abstract,type,&mailto=local-citation-network@timwoelfle.de').then(response => {
    if (!response.ok) throw (response)
    return response.json()
  }).then(data => {
    if (typeof data !== 'object' || !data.message || !data.message.items || !data.message.items[0]) throw ({ statusText: 'Empty response', status: 200 })
    return (data.message.items[0])
  }).catch(async function (response) {
    if (response.status === 429 || typeof response.statusText !== 'string') {
      if (response.status === 429) vm.errorMessage('Crossref reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('Crossref not reachable. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return crossrefWorks(id)
    }
    vm.errorMessage('Error while processing data through Crossref API for ' + id + ': ' + response.statusText + ' (' + response.status + ')')
    // Add placeholders for missing items with reason
    return { title: 'Missing: ' + id + ' (' + response.statusText + ', ' + response.status + ')' }
  })
}

function crossrefResponseToArticleArray (data) {
  return data.filter(Boolean).map(article => {
    const doi = article.DOI?.toUpperCase()

    function formatDate (year, month, day) {
      // Create a new Date object with the provided year, month, and day
      const date = new Date(year, month - 1, day)

      // Get the individual components of the date
      const formattedYear = date.getFullYear()
      const formattedMonth = String(date.getMonth() + 1).padStart(2, '0')
      const formattedDay = String(date.getDate()).padStart(2, '0')

      // Return the formatted date in the YYYY-MM-DD format
      return `${formattedYear}-${formattedMonth}-${formattedDay}`
    }

    return {
      id: doi,
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      type: article.type,
      title: String(article.title), // most of the time title is an array with length=1, but I've also seen pure strings
      authors: (article.author?.length) ? article.author.map(x => ({
        orcid: x.ORCID,
        LN: x.family || x.name,
        FN: x.given,
        affil: (x.affiliation?.length) ? x.affiliation.map(aff => aff.name).join(', ') : (typeof (x.affiliation) === 'string' ? x.affiliation : undefined)
      })) : [{ LN: article.author || undefined }],
      year: article.issued?.['date-parts']?.[0]?.[0],
      date: (article.issued?.['date-parts']?.[0]?.[0]) ? formatDate(article.issued['date-parts'][0][0], article.issued['date-parts'][0][1], article.issued['date-parts'][0][2]) : undefined,
      journal: String(article['container-title']),
      // Crossref "references" array contains null positions for references it doesn't have DOIs for, thus preserving the original number of references
      references: article.reference?.map(x => x.DOI?.toUpperCase()),
      referencesCount: article.reference?.length,
      citationsCount: article['is-referenced-by-count'],
      abstract: article.abstract
    }
  })
}

/* OpenCitations API */
// https://opencitations.net/index/api/v1#/metadata/{dois}

async function openCitationsWrapper (ids, responseFunction, phase) {
  const responses = []
  vm.isLoadingTotal = ids.length
  for (const i of Array(ids.length).keys()) {
    let response
    vm.isLoadingIndex = i
    if (ids[i]) response = (await openCitationsMetadata(ids[i]))[0]
    responses.push(response)
  }
  vm.isLoadingTotal = 0
  responseFunction(responses)
}

function openCitationsMetadata (id) {
  return fetch('https://opencitations.net/index/api/v1/metadata/' + id + '?mailto=local-citation-network@timwoelfle.de').then(response => {
    if (!response.ok) throw (response)
    return response.json()
  }).then(data => {
    if (typeof data !== 'object' || !data.length) throw ({ statusText: 'Empty response', status: 200 })
    return data
  }).catch(async function (response) {
    if ((response.status === 429 || typeof response.statusText !== 'string') && response.status !== 404) {
      if (response.status === 429) vm.errorMessage('OpenCitations (OC) reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('OpenCitations (OC) not reachable. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return openCitationsMetadata(id)
    }
    vm.errorMessage('Error while processing data through OpenCitations API for ' + id + ': ' + response.statusText + ' (' + response.status + ')')
    // Add placeholders for missing items with reason (OC always returns an array, which is why (await openCitationsMetadata(ids[i]))[0] is selected above)
    return [{ title: 'Missing: ' + id + ' (' + response.statusText + ', ' + response.status + ')' }]
  })
}

function openCitationsResponseToArticleArray (data) {
  return data.filter(Boolean).map(article => {
    const doi = article.doi?.toUpperCase()

    return {
      id: doi,
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      title: String(article.title), // most of the time title is an array with length=1, but I've also seen pure strings
      authors: article.author?.split('; ').map(x => ({ LN: x.split(', ')[0], FN: x.split(', ')[1] })) ?? [],
      year: Number(article.year?.substr(0, 4)) || undefined,
      date: article.year, // is apparerently sometimes date not only year
      journal: article.source_title,
      volume: article.volume,
      issue: article.issue,
      firstPage: article.page?.split('-')?.[0],
      lastPage: article.page?.split('-')?.[1],
      references: article.reference?.split('; ').map(x => x.toUpperCase()),
      referencesCount: article.reference?.split('; ').length,
      citations: article.citation?.split('; ').map(x => x.toUpperCase()),
      citationsCount: Number(article.citation_count) || undefined
    }
  })
}

/* vis.js Reference graph */

// I've tried keeping citationNetwork in Vue's data, but it slowed things down a lot -- better keep it as global variable as network is not rendered through Vue anyway
let citationNetwork, authorNetwork

function htmlTitle (html) {
  const container = document.createElement('div')
  container.innerHTML = vm.formatTags(html)
  return container
}

function initCitationNetwork (app, minDegreeIncomingSuggestions = 1, minDegreeOutgoingSuggestions = 1) {
  // This line is necessary because of v-if="currentTabIndex !== undefined" in the main columns div, which apparently is evaluated after watch:currentTabIndex is called
  if (!document.getElementById('citationNetwork')) return setTimeout(function () { app.init() }, 1)

  // Only init network if it doesn't exist yet (or was previously reset == destroyed)
  if (document.getElementById('citationNetwork').innerHTML !== '') return false

  app.citationNetworkIsLoading = true

  // Filter articles according to settings
  // Articles must have year for hierarchical layout
  const sourceId = app.currentGraph.source.id
  const inputArticles = app.currentGraph.input
    .filter(article => article.year)
    .filter(article => (app.citationNetworkShowSource ? true : !article.isSource))
  const incomingSuggestions = (app.currentGraph.incomingSuggestions ?? [])
    // De-duplicate against inputArticles (only relevant when All References are retrieved)
    .filter(article => !app.inputArticlesIds.includes(article.id))
    .filter(article => article.year)
    .filter(article => app.inDegree(article.id) + app.outDegree(article.id) >= minDegreeIncomingSuggestions)
    .toSorted((a, b) => vm.sortInDegreeWrapper(a, b, false))
    .slice(0, app.maxIncomingSuggestions)
  const outgoingSuggestions = (app.currentGraph.outgoingSuggestions ?? [])
    // De-duplicate against inputArticles and incomingSuggestions (only relevant when All References are retrieved)
    .filter(article => !app.inputArticlesIds.includes(article.id) && !app.incomingSuggestionsIds.includes(article.id))
    .filter(article => article.year)
    .filter(article => app.inDegree(article.id) + app.outDegree(article.id) >= minDegreeOutgoingSuggestions)
    .toSorted((a, b) => vm.sortOutDegreeWrapper(a, b, false))
    .slice(0, app.maxOutgoingSuggestions)

  // Create an array with edges
  // Only keep connected articles (no singletons)
  let articles = new Set()
  // Edges from inputArticles
  let edges = inputArticles.concat(incomingSuggestions).concat(outgoingSuggestions).map(article => app.referencedCiting.referenced[article.id]?.map(fromId => {
    // Some input articles have been removed above (e.g. those without year, so double check here)
    if (inputArticles.map(x => x.id).includes(fromId)) {
      if (app.citationNetworkShowSource || fromId != sourceId) {
        articles.add(article)
        articles.add(inputArticles[inputArticles.map(x => x.id).indexOf(fromId)])
        return { from: fromId, to: article.id }
      }
    }
  }))
  // Edges from incomingSuggestions and outgoingSuggestions to inputArticles
  edges = edges.concat(incomingSuggestions.concat(outgoingSuggestions).map(article => app.referencedCiting.citing[article.id]?.map(toId => {
    // Some input articles have been removed above (e.g. those without year, so double check here)
    if (inputArticles.map(x => x.id).includes(toId)) {
      if (app.citationNetworkShowSource || toId != sourceId) {
        articles.add(article)
        articles.add(inputArticles[inputArticles.map(x => x.id).indexOf(toId)])
        return { from: article.id, to: toId }
      }
    }
  })))
  edges = edges.flat().filter(Boolean)

  articles = Array.from(articles)

  if (!articles.length) {
    app.citationNetworkIsLoading = false
  }

  // Sort hierarchical levels by rank of year
  const years = Array.from(new Set(articles.map(article => article?.year).sort()))

  const nodes = articles.map(article => ({
    id: article.id,
    title: htmlTitle(app.authorStringShort(article.authors) + '. <a><em>' + article.title + '</em></a>. ' + article.journal + '. ' + article.year + '.<br>(Double click opens article: <a>' + String(app.articleLink(article)).substr(0, 28) + '...</a>)'),
    level: years.indexOf(article.year),
    group: article[app.citationNetworkNodeColor],
    value: arrSum([['in', 'both'].includes(app.citationNetworkNodeSize) ? app.inDegree(article.id) : 0, ['out', 'both'].includes(app.citationNetworkNodeSize) ? app.outDegree(article.id) : 0]),
    shape: (sourceId === article.id) ? 'diamond' : (app.inputArticlesIds.includes(article.id) ? 'dot' : (app.incomingSuggestionsIds.includes(article.id) ? 'triangle' : 'triangleDown')),
    label: article.authors[0]?.LN + '\n' + article.year
  }))

  // Create network
  const options = {
    layout: {
      hierarchical: {
        direction: (app.currentGraph.citationNetworkTurned) ? 'LR' : 'DU',
        levelSeparation: 40,
        nodeSpacing: 10
      }
    },
    nodes: {
      font: {
        strokeWidth: 3,
        strokeColor: '#eeeeee'
      },
      scaling: {
        min: 3,
        max: 30,
        label: {
          enabled: true,
          min: 10,
          max: 30,
          maxVisible: 300,
          drawThreshold: 10
        }
      }
    },
    edges: {
      color: {
        color: 'rgba(0,0,0,0.05)',
        highlight: 'rgba(0,0,0,0.8)'
      },
      arrows: {
        to: {
          enabled: true,
          scaleFactor: 0.4
        }
      },
      width: 0.8,
      selectionWidth: 0.8,
      smooth: false
    },
    interaction: {
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true,
      keyboard: {
        enabled: true,
        bindToWindow: false,
        autoFocus: false
      }
    },
    physics: {
      enabled: true,
      hierarchicalRepulsion: {
        nodeDistance: 80
      }
    },
    configure: {
      enabled: true,
      container: document.getElementById('citationNetworkConfigure')
    }
  }

  citationNetwork = new vis.Network(document.getElementById('citationNetwork'), { nodes: nodes, edges: edges }, options)
  citationNetwork.on('click', networkOnClick)
  citationNetwork.on('doubleClick', networkOnDoubleClick)

  citationNetwork.stabilize(citationNetwork.body.nodeIndices.length)
  citationNetwork.on('stabilizationIterationsDone', function (params) {
    app.citationNetworkIsLoading = false
    citationNetwork.setOptions({ physics: false })
    citationNetwork.fit()
  })

  // Draw a white background behind canvas so that right-click "Open/Save Image" works properly
  citationNetwork.on('beforeDrawing', function (ctx) {
    // https://github.com/almende/vis/issues/2292#issuecomment-372044181
    // save current translate/zoom
    ctx.save()
    // reset transform to identity
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // fill background with solid white
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    // restore old transform
    ctx.restore()
  })

  function networkOnClick (params) {
    let selectedNodeId

    // Select corresponding row in table
    if (params.nodes.length > 0) {
      selectedNodeId = params.nodes[0]
      // Input article node was clicked (circle)
      if (app.inputArticlesIds.includes(selectedNodeId)) {
        app.showArticlesTab = 'inputArticles'
        app.selected = app.currentGraph.input[app.inputArticlesIds.indexOf(selectedNodeId)]
      // Suggested article node was clicked (triangle)
      } else if (app.incomingSuggestionsIds.includes(selectedNodeId)) {
        app.showArticlesTab = 'topReferences'
        app.selected = app.currentGraph.incomingSuggestions[app.incomingSuggestionsIds.indexOf(selectedNodeId)]
      } else {
        app.showArticlesTab = 'topCitations'
        app.selected = app.currentGraph.outgoingSuggestions[app.outgoingSuggestionsIds.indexOf(selectedNodeId)]
      }
    // Don't select edges
    } else {
      app.selected = undefined
      citationNetwork.setSelection({
        nodes: [],
        edges: []
      })
    }
  }

  function networkOnDoubleClick (params) {
    // Open article in new tab
    if (params.nodes.length > 0) {
      window.open(app.articleLink(app.selected), '_blank')
    } else {
      citationNetwork.fit()
    }
  }
}

function initAuthorNetwork (app, minPublications = undefined) {
  if (!document.getElementById('authorNetwork')) return false

  // Only init network if it doesn't exist yet (or was previously reset == destroyed)
  if (document.getElementById('authorNetwork').innerHTML !== '') return false

  app.authorNetworkIsLoading = true

  // Deep copy articles because otherwise sorting (and setting "x.id = ..." later) would overwrite currentGraph's articles
  const articles = JSON.parse(JSON.stringify(app.currentGraph.input))
  articles.sort((articleA, articleB) => (app.authorNetworkNodeColor === 'firstArticle') ? articleA.year - articleB.year : articleB.year - articleA.year)

  // Used to be "x.id = x.id || x.name" but caused too many duplicates (at least on OA), double check in the future if this has been fixed
  let allAuthors = articles.map(article => article.authors.map(x => { x.name = app.authorString([x]); x.id = x.name; return x }))
  let authorIdGroups = allAuthors.map(authorGroup => authorGroup.map(author => author.id))
  allAuthors = Object.fromEntries(allAuthors.flat().map(author => [author.id, author]))

  // Count publications per author
  const publicationsCount = {}
  authorIdGroups.flat().forEach(authorId => {
    publicationsCount[authorId] = (publicationsCount[authorId] || 0) + 1
  })

  let authorIdsWithMinPubs = []
  const links = {}

  if (!minPublications) {
    // Default minPublications: Increase iteratively until <= 50 authors are shown
    minPublications = 2
    authorIdsWithMinPubs = Object.keys(publicationsCount).filter(authorId => publicationsCount[authorId] >= minPublications)
    while (authorIdsWithMinPubs.length > 50) {
      minPublications++
      authorIdsWithMinPubs = Object.keys(publicationsCount).filter(authorId => publicationsCount[authorId] >= minPublications)
    }
    app.authorNetworkMinPublications = minPublications
  } else {
    authorIdsWithMinPubs = Object.keys(publicationsCount).filter(authorId => publicationsCount[authorId] >= minPublications)
  }

  if (!authorIdsWithMinPubs.length) {
    app.authorNetworkIsLoading = false
  }

  authorIdGroups = authorIdGroups.map(group => group.filter(authorId => authorIdsWithMinPubs.includes(authorId)))

  authorIdGroups.forEach(group => group.forEach(authorId1 => group.forEach(authorId2 => {
    if (authorId1 === authorId2) return false

    // Is there already a link for this pair? If so, make it stronger
    if (links[authorId1]?.[authorId2]) return links[authorId1][authorId2]++
    if (links[authorId2]?.[authorId1]) return links[authorId2][authorId1]++

    // Create new link
    if (!links[authorId1]) links[authorId1] = {}
    links[authorId1][authorId2] = 1
  })))

  const edges = Object.keys(links).map(authorId1 => Object.keys(links[authorId1]).map(authorId2 => {
    return { from: authorId1, to: authorId2, value: links[authorId1][authorId2], title: allAuthors[authorId1].name + ' & ' + allAuthors[authorId2].name + ' (' + links[authorId1][authorId2] / 2 + ' collaboration(s) among input & suggested articles)' }
  })).flat(2)

  const nodes = authorIdsWithMinPubs.map(authorId => {
    const author = allAuthors[authorId]
    const isSourceAuthor = app.authorString(app.currentGraph.source.authors).includes(author.name)
    const inputArticlesAuthoredCount = app.currentGraph.input.filter(article => app.authorString(article.authors).includes(author.name)).length
    const authorIdGroupIndex = authorIdGroups.map(group => group.includes(author.id)).indexOf(true)
    return {
      id: author.id,
      title: htmlTitle(author.name + ': author of ' + inputArticlesAuthoredCount + ' input articles' + (isSourceAuthor ? ' (including source)' : '') + '.<br>' + (author.affil ? 'Affiliation(s): ' + author.affil + '<br>' : '') + ' Color by ' + ((app.authorNetworkNodeColor === 'firstArticle') ? 'first' : 'last') + ' article: ' + articles[authorIdGroupIndex].title + ' <br>(Double click opens author: <a>' + app.authorLink(author).substr(0, 28) + '...</a>)'),
      group: authorIdGroupIndex,
      label: ((app.authorNetworkFirstNames) ? (author.FN + ' ') : '') + author.LN,
      value: publicationsCount[author.id],
      mass: publicationsCount[author.id],
      shape: (isSourceAuthor) ? 'diamond' : 'dot'
    }
  })

  // create a network
  const options = {
    nodes: {
      font: {
        strokeWidth: 3,
        strokeColor: '#eeeeee'
      },
      scaling: {
        min: 10,
        max: 30,
        label: {
          enabled: true,
          min: 14,
          max: 30,
          maxVisible: 30,
          drawThreshold: 8
        }
      }
    },
    edges: {
      color: {
        inherit: 'both'
      },
      smooth: false
    },
    physics: {
      barnesHut: {
        centralGravity: 10
      },
      maxVelocity: 20
    },
    interaction: {
      multiselect: true,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true,
      keyboard: {
        enabled: true,
        bindToWindow: false,
        autoFocus: false
      }
    },
    configure: {
      enabled: true,
      container: document.getElementById('authorNetworkConfigure')
    }
  }
  authorNetwork = new vis.Network(document.getElementById('authorNetwork'), { nodes: nodes, edges: edges }, options)
  authorNetwork.on('click', networkOnClick)
  authorNetwork.on('doubleClick', networkOnDoubleClick)

  authorNetwork.stabilize(100)
  authorNetwork.on('stabilizationIterationsDone', function (params) {
    app.authorNetworkIsLoading = false
    authorNetwork.setOptions({ physics: false })
    authorNetwork.fit()
  })

  authorNetwork.on('beforeDrawing', function (ctx) {
    // https://github.com/almende/vis/issues/2292#issuecomment-372044181
    // save current translate/zoom
    ctx.save()
    // reset transform to identity
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // fill background with solid white
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    // restore old transform
    ctx.restore()
  })

  function networkOnClick (params) {
    app.filterColumn = 'authors'

    // If no node is clicked...
    if (!params.nodes.length) {
      // Maybe an edge?
      if (params.edges.length) {
        const edge = authorNetwork.body.data.edges.get(params.edges[0])
        params.nodes = [edge.from, edge.to]
        app.filterString = '(?=.*' + allAuthors[edge.from].name + ')(?=.*' + allAuthors[edge.to].name + ')'
        // Otherwise reset filterString
      } else {
        app.selected = undefined
        app.filterString = undefined
      }
    // If just one node is selected perform simple filter for that author
    } else if (params.nodes.length === 1) {
      app.filterString = allAuthors[params.nodes[0]].name
      // If more than one node are selected, perform "boolean and" in regular expression through lookaheads, which means order isn't important (see https://www.ocpsoft.org/tutorials/regular-expressions/and-in-regex/)
    } else {
      app.filterString = '(?=.*' + params.nodes.map(x => allAuthors[x].name).join(')(?=.*') + ')'
    }

    app.highlightNodes(params.nodes)
  }

  function networkOnDoubleClick (params) {
    // Open author in new tab
    if (params.nodes.length > 0) {
      window.open(app.authorLink(allAuthors[params.nodes[0]]), '_blank')
    } else {
      authorNetwork.fit()
    }
  }
}

/* App logic */

Vue.use(Buefy)

const vm = new Vue({
  el: '#app',
  data: {
    // Settings
    API: 'OpenAlex', // Options: 'OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref'
    semanticScholarAPIKey: '',
    retrieveReferences: 10,
    retrieveCitations: 10,
    maxTabs: 5,
    autosaveResults: false,

    // Data
    graphs: [],
    newSourceId: undefined,
    file: undefined,
    listOfIds: undefined,
    listName: undefined,
    bookmarkletURL: undefined,

    // UI
    fullscreenTable: false,
    fullscreenNetwork: false,
    filterColumn: 'titleAbstract',
    filterString: undefined,
    selectedInputArticle: undefined,
    selectedIncomingSuggestionsArticle: undefined,
    selectedOutgoingSuggestionsArticle: undefined,
    articlesPerPage: 20,
    inputArticlesTablePage: 1,
    topReferencesTablePage: 1,
    topCitationsTablePage: 1,
    currentTabIndex: undefined,
    showArticlesTab: 'inputArticles',
    showAuthorNetwork: 0,
    isLoading: false,
    isLoadingIndex: 0,
    isLoadingTotal: 0,
    citationNetworkIsLoading: undefined,
    authorNetworkIsLoading: undefined,
    showFAQ: false,
    indexFAQ: 'about',
    editListOfIds: false,
    showCitationNetworkSettings: false,
    showAuthorNetworkSettings: false,
    showOptionsAPI: false
  },
  computed: {
    editedListOfIds: {
      get: function () { return (this.listOfIds || []).join('\n') },
      set: function (x) { this.listOfIds = x.split('\n').map(x => x.replaceAll(/\s/g, '')) }
    },
    currentGraph: function () {
      if (this.currentTabIndex === undefined) return {}
      return this.graphs[this.currentTabIndex]
    },
    inputArticlesIds: function () {
      return this.currentGraph.input.map(article => article.id)
    },
    incomingSuggestionsIds: function () {
      return this.currentGraph.incomingSuggestions.map(article => article.id)
    },
    outgoingSuggestionsIds: function () {
      return this.currentGraph.outgoingSuggestions.map(article => article.id)
    },
    inputArticlesFiltered: function () {
      return this.filterArticles(this.currentGraph.input, true)
    },
    incomingSuggestionsFiltered: function () {
      return this.filterArticles(this.currentGraph.incomingSuggestions ?? [])
    },
    outgoingSuggestionsFiltered: function () {
      return this.filterArticles(this.currentGraph.outgoingSuggestions ?? [])
    },
    referencedCiting: function () {
      const articles = this.currentGraph.input.concat(this.currentGraph.incomingSuggestions || []).concat(this.currentGraph.outgoingSuggestions || [])
      const referencedCiting = this.computeInputArticlesRelationships(articles, this.inputArticlesIds)
      let referenced = referencedCiting.inputArticlesA
      const citing = referencedCiting.inputArticlesB
      // Reduce referenced Object to items with key in articles.id
      referenced = articles.map(x => x.id).filter(x => Object.keys(referenced).includes(x)).reduce((reducedReferenced, id) => { reducedReferenced[id] = referenced[id]; return reducedReferenced }, {})
      return { referenced, citing }
    },
    selected: {
      get: function () {
        switch (this.showArticlesTab) {
          case 'inputArticles': return this.selectedInputArticle
          case 'topReferences': return this.selectedIncomingSuggestionsArticle
          case 'topCitations': return this.selectedOutgoingSuggestionsArticle
        }
      },
      set: function (x) {
        switch (this.showArticlesTab) {
          case 'inputArticles':
            this.selectedInputArticle = x
            if (x) this.inputArticlesTablePage = Math.ceil((this.$refs.inputArticlesTable.newData.indexOf(x) + 1) / vm.articlesPerPage)
            break
          case 'topReferences':
            this.selectedIncomingSuggestionsArticle = x
            if (x) this.topReferencesTablePage = Math.ceil((this.$refs.topReferencesTable.newData.indexOf(x) + 1) / vm.articlesPerPage)
            break
          case 'topCitations':
            this.selectedOutgoingSuggestionsArticle = x
            if (x) this.topCitationsTablePage = Math.ceil((this.$refs.topCitationsTable.newData.indexOf(x) + 1) / vm.articlesPerPage)
            break
        }
        if (x && document.getElementById(x.id)) document.getElementById(x.id).scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    },
    linkToShareAppendix: function () {
      let appendix = '?API=' + encodeURIComponent(this.currentGraph.API)
      if (this.currentGraph.source.id) {
        appendix += '&source=' + (this.currentGraph.source.doi ? this.currentGraph.source.doi : this.currentGraph.source.id)
        if (this.currentGraph.source.customListOfReferences) {
          appendix += '&listOfIds=' + this.currentGraph.source.customListOfReferences.join(',')
        }
        if (this.currentGraph.bookmarkletURL) {
          appendix += '&bookmarkletURL=' + this.currentGraph.bookmarkletURL
        }
      } else {
        appendix += '&name=' + encodeURIComponent(this.currentGraph.tabLabel) + '&listOfIds=' + this.currentGraph.source.references.join(',')
      }
      return appendix
    },
    showNumberInSourceReferences: function () {
      return this.currentGraph.API === 'Crossref' || (this.currentGraph.source.customListOfReferences !== undefined) || !this.currentGraph.source.id
    },
    // The following are settings and their default values
    maxIncomingSuggestions: {
      get: function () { return this.currentGraph.maxIncomingSuggestions ?? Math.min(10, this.currentGraph.incomingSuggestions?.length) },
      set: function (x) { if (x >= 0 && x <= this.currentGraph.incomingSuggestions?.length) this.$set(this.currentGraph, 'maxIncomingSuggestions', Number(x)) }
    },
    maxOutgoingSuggestions: {
      get: function () { return this.currentGraph.maxOutgoingSuggestions ?? Math.min(10, this.currentGraph.outgoingSuggestions?.length) },
      set: function (x) { if (x >= 0 && x <= this.currentGraph.outgoingSuggestions?.length) this.$set(this.currentGraph, 'maxOutgoingSuggestions', Number(x)) }
    },
    minDegreeIncomingSuggestions: {
      get: function () { return this.currentGraph.minDegreeIncomingSuggestions ?? 1 },
      set: function (x) { this.$set(this.currentGraph, 'minDegreeIncomingSuggestions', Number(x)) }
    },
    minDegreeOutgoingSuggestions: {
      get: function () { return this.currentGraph.minDegreeOutgoingSuggestions ?? 1 },
      set: function (x) { this.$set(this.currentGraph, 'minDegreeOutgoingSuggestions', Number(x)) }
    },
    citationNetworkNodeColor: {
      // Options: 'year', 'journal'
      get: function () { return this.currentGraph.citationNetworkNodeColor ?? 'year' },
      set: function (x) { this.$set(this.currentGraph, 'citationNetworkNodeColor', x) }
    },
    citationNetworkNodeSize: {
      // Options: 'both', 'in', 'out
      get: function () { return this.currentGraph.citationNetworkNodeSize ?? 'both' },
      set: function (x) { this.$set(this.currentGraph, 'citationNetworkNodeSize', x) }
    },
    citationNetworkShowSource: {
      get: function () { return this.currentGraph.citationNetworkShowSource ?? true },
      set: function (x) { this.$set(this.currentGraph, 'citationNetworkShowSource', x) }
    },
    authorNetworkNodeColor: {
      // Options: 'firstArticle', 'lastArticle'
      get: function () { return this.currentGraph.authorNetworkNodeColor ?? 'firstArticle' },
      set: function (x) { this.$set(this.currentGraph, 'authorNetworkNodeColor', x) }
    },
    authorNetworkFirstNames: {
      get: function () { return this.currentGraph.authorNetworkFirstNames ?? false },
      set: function (x) { this.$set(this.currentGraph, 'authorNetworkFirstNames', x) }
    },
    authorNetworkMinPublications: {
      get: function () { return this.currentGraph.authorNetworkMinPublications },
      set: function (x) { this.$set(this.currentGraph, 'authorNetworkMinPublications', x) }
    },
    // The following are for the estimation of the completeness of the data
    completenessOriginalReferencesCount: function () {
      return (this.currentGraph.source.customListOfReferences || this.currentGraph.source.references).length
    },
    completenessInputArticlesWithoutSource: function () {
      // Removes placeholders for missing articles (without id) and source article from Input Articles list
      return this.currentGraph.input.filter(article => article.id && !article.isSource)
    },
    completenessOriginalReferencesFraction: function () {
      return this.completenessInputArticlesWithoutSource.length / this.completenessOriginalReferencesCount
    },
    completenessInputHasReferences: function () {
      return arrSum(this.completenessInputArticlesWithoutSource.map(x => (x.references?.length ?? 0) !== 0))
    },
    completenessInputReferencesFraction: function () {
      return arrAvg(this.completenessInputArticlesWithoutSource.filter(x => (x.references?.length ?? 0) !== 0).map(x => x.references.filter(Boolean).length / x.references.length))
    },
    completenessLabel: function () {
      let label = ''
      // Show number of "original references" for source-based-graphs when available from API and for all listOfIds (i.e. file / bookmarklet) graphs
      if (['Semantic Scholar', 'Crossref', 'OpenCitations'].includes(this.currentGraph.API) || this.currentGraph.source.customListOfReferences || !this.currentGraph.source.id) {
        if (this.currentGraph.source.id) {
          label += 'Source and '
        }
        label += `${this.completenessInputArticlesWithoutSource.length} of originally ${this.completenessOriginalReferencesCount} (${Math.round(this.completenessOriginalReferencesFraction * 100)}%) references were found in ${this.currentGraph.API}, ${this.completenessInputHasReferences} of which have reference-lists themselves (${Math.round(this.completenessInputHasReferences / this.completenessInputArticlesWithoutSource.length * 100)}%).`
      } else {
        label = `${this.completenessInputHasReferences} of ${this.completenessInputArticlesWithoutSource.length} input articles ${this.currentGraph.source.id ? '(excluding source) ' : ''}have reference-lists themselves in ${this.currentGraph.API} (${Math.round(this.completenessInputHasReferences / this.completenessInputArticlesWithoutSource.length * 100)}%).`
      }

      if (['Semantic Scholar', 'Crossref'].includes(this.currentGraph.API)) label += ` Their respective average reference completeness is ${Math.round(this.completenessInputReferencesFraction * 100)}%.`
      return label
    },
    completenessPercent: function () {
      return Math.round(this.completenessOriginalReferencesFraction * (this.completenessInputHasReferences / this.completenessInputArticlesWithoutSource.length) * this.completenessInputReferencesFraction * 100)
    }
  },
  watch: {
    // User provided a new DOI or other id for source article
    newSourceId: function () {
      if (!this.newSourceId || !this.newSourceId.replaceAll(/\s/g, '')) return false

      this.newSourceId = this.newSourceId.replaceAll(/\s/g, '').replace(/DOI:|https:\/\/doi.org\//i, '')

      // OpenCitations and Crossref only allow DOIs as ids
      if (['OpenCitations', 'Crossref'].includes(this.API)) {
        if (this.newSourceId.match(/10\.\d{4,9}\/\S+/)) {
          this.newSourceId = this.newSourceId.match(/10\.\d{4,9}\/\S+/)[0]
        } else {
          this.errorMessage(this.newSourceId + ' is not a valid DOI, which must be in the form: 10.prefix/suffix where prefix is 4 or more digits and suffix is a string.')
          this.newSourceId = undefined
          return false
        }
      }

      if (!this.editListOfIds && !this.isLoading) this.setNewSource(this.newSourceId)
    },
    // User provided a file...
    file: function () {
      if (!this.file || !this.file.name) return false
      this.isLoading = true
      this.file.text().then(text => {
        this.isLoading = false
        // ... which is either a stored network file (JSON), which can be loaded directly
        if (this.file.type === 'application/json') {
          const graphs = JSON.parse(text)
          // However, not all JSONs loaded are necessarily from this tool
          if (Array.isArray(graphs) && graphs.every(graph => graph.localCitationNetworkVersion)) {
            this.addGraphs(graphs)
            this.file = undefined
            return (true)
          }
        }
        // ... or a plain text file to be searched for DOIs
        // Using the set [-_;()/:A-Z0-9] twice (fullstop . and semicolon ; only in first set) makes sure that the trailing character is not a fullstop or semicolon
        const DOIs = Array.from(new Set(text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+[-_()/:A-Z0-9]+/gi))).map(x => x.toUpperCase())
        if (!DOIs.length) throw new Error('No DOIs found in file.')
        this.listOfIds = DOIs
        this.listName = this.file.name
        this.editListOfIds = true
        this.file = undefined
      }).catch(e => {
        this.isLoading = false
        this.errorMessage('Error with file handling: ' + e)
        // Reset input variables so that watchers fire again even if same input is given
        this.file = undefined
      })
    },
    // A different node (reference) in the graph or a different article in the table has been selected
    selected: function () {
      // Highlight the right network node
      this.highlightNodes()
    },
    showAuthorNetwork: function () {
      this.initCurrentNetwork()
    },
    showArticlesTab: function () {
      if (
        this.showArticlesTab === 'inputArticles' && ['citedByInputArticleId', 'citesInputArticleId'].includes(this.filterColumn) ||
        this.showArticlesTab !== 'inputArticles' && ['citedById', 'citingId'].includes(this.filterColumn)
      ) {
        this.filterColumn = 'titleAbstract'
        this.filterString = ''
      }
    }
  },
  methods: {
    // Initialize graph when new tab is opened / tab is changed
    setCurrentTabIndex: function (index) {
      // Reset UI elements when tab is changed
      this.showArticlesTab = 'inputArticles'
      this.filterString = undefined
      this.selected = undefined

      // Reset table paging
      this.inputArticlesTablePage = 1
      this.topReferencesTablePage = 1
      this.topCitationsTablePage = 1

      this.currentTabIndex = index
      if (index !== undefined) this.init()
    },
    computeInputArticlesRelationships: function (aArticles, inputArticlesIds, variable = 'references') {
      // Replaces former populateReferencedCiting
      // Removes duplicates (e.g. https://api.crossref.org/works/10.7717/PEERJ.3544 has 5 references to DOI 10.1080/00031305.2016.1154108).
      // @param articles: Array of articles-Objects each containing id and variable
      // @param variable: Either 'references' or 'citations': Arrays of article-ids
      const inputArticlesA = {}; const inputArticlesB = {}
      aArticles.forEach(aArticle => {
        const aId = aArticle.id
        aArticle[variable]?.filter(Boolean).forEach(bId => {
          if (inputArticlesIds.includes(aId)) {
            if (!inputArticlesA[bId]) inputArticlesA[bId] = []
            if (!inputArticlesA[bId].includes(aId)) inputArticlesA[bId].push(aId)
          }
          if (inputArticlesIds.includes(bId)) {
            if (!inputArticlesB[aId]) inputArticlesB[aId] = []
            if (!inputArticlesB[aId].includes(bId)) inputArticlesB[aId].push(bId)
          }
        })
      })
      return { inputArticlesA, inputArticlesB }
    },
    setNewSource: function (id, customListOfReferences = undefined) {
      this.isLoading = true

      // Reset newSourceId (otherwise it cannot be called twice in a row with different APIs)
      this.newSourceId = undefined

      const API = this.API
      this.callAPI([id], data => this.setNewSourceResponse(data, API, customListOfReferences), API, 'source')
    },
    setNewSourceResponse: function (data, API, customListOfReferences) {
      const source = this.responseToArray(data, API)[0]
      source.isSource = true

      if (source && customListOfReferences) {
        source.references = customListOfReferences
        source.customListOfReferences = customListOfReferences
      }

      // Some papers can be found in the APIs but don't have references themselves in there
      if (!source) {
        this.isLoading = false
        return this.errorMessage(`Empty response from ${this.API} API, maybe source not found. Try other API.`)
      }
      if (!source.references.length) {
        this.isLoading = false
        return this.errorMessage(`No references found for source in ${this.API} API, try other API.`)
      }

      this.createNewNetwork(source)
    },
    createNewNetwork: function (source) {
      // In case of file scanning, isLoading has not yet been set by setNewSource
      this.isLoading = true

      this.$buefy.toast.open({
        message: 'New query sent to ' + this.API + '.<br>This may take a while, depending on the number of references and API workload.',
        duration: 6000,
        queue: false
      })

      // Get Input articles
      this.callAPI(source.references, data => this.retrievedInputArticles(data, source, this.API, this.retrieveReferences, this.retrieveCitations), this.API, 'input', this.retrieveReferences === Infinity, this.retrieveCitations === Infinity)
    },
    retrievedInputArticles: function (data, source, API, retrieveReferences, retrieveCitations) {
      let inputArticles = this.responseToArray(data, API)

      // If source has customListOfReferences its references must be updated to match id format of API (otherwise inDegree and outDegree and network don't work correctly)
      // Original list was kept in source.customListOfReferences
      if (source.customListOfReferences) {
        source.references = inputArticles.map(article => article.id)
      }

      // Don't put source in inputArticles when a list without source was loaded
      const inputArticlesIdsWithoutSource = inputArticles.map(article => article.id)
      if (source.id) inputArticles = inputArticles.concat(source)
      const inputArticlesIds = inputArticles.map(article => article.id)

      // Temporary scope variables needed (without having been reduced like in computed.referencedCiting!) for getting id lists for Top References / Top Citations
      let referenced, citing
      if (!(retrieveReferences === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API))) {
        referenced = this.computeInputArticlesRelationships(inputArticles, inputArticlesIds).inputArticlesA
      }
      if (!(retrieveCitations === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API))) {
        citing = this.computeInputArticlesRelationships(inputArticles, inputArticlesIds, 'citations').inputArticlesA
      }

      // Delete citations arrays in articles to save space, they were only needed for calculating citing (above) for "Top citations"
      inputArticles = inputArticles.map(article => { delete article.citations; return article })

      // Add new tab
      const newGraph = {
        source: source,
        input: inputArticles,
        incomingSuggestions: (retrieveReferences) ? undefined : [], // undefined leads to loading indicator, empty array means no references
        outgoingSuggestions: (retrieveCitations && API !== 'Crossref') ? undefined : [], // undefined leads to loading indicator, empty array means no citations
        tabLabel: source.id ? ((source.authors[0] && source.authors[0].LN) + ' ' + source.year) : this.listName,
        tabTitle: source.id ? source.title : this.listName,
        bookmarkletURL: this.bookmarkletURL,
        API: API,
        allReferences: retrieveReferences === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API),
        allCitations: retrieveCitations === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API),
        timestamp: Date.now(),
        localCitationNetworkVersion: localCitationNetworkVersion
      }
      this.pushGraph(newGraph)
      vm.saveState()
      this.isLoading = false
      this.listName = undefined
      this.bookmarkletURL = undefined

      /* Perform API call for All / Top References (formerly Incoming suggestions) */
      // OA & S2: If all references are supposed to be retrieved get multiple references at once based on inputArticlesIds (faster)
      // Otherwise use ids derived from references
      let incomingSuggestionsIds
      if (!(retrieveReferences === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API))) {
        incomingSuggestionsIds = Object.keys(referenced)
          // De-duplicate vs inputArticles in case only Top References are retrieved
          .filter(x => !inputArticlesIds.includes(x))
          // Sort and slice for Top References
          .sort((a, b) => referenced[b].length - referenced[a].length).slice(0, retrieveReferences)
      }
      this.callAPI((retrieveReferences === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API)) ? inputArticlesIdsWithoutSource : incomingSuggestionsIds, data => this.retrievedIncomingSuggestions(data, API, newGraph, retrieveCitations, citing, inputArticlesIds), API, 'references', retrieveReferences === Infinity, false)
    },
    retrievedIncomingSuggestions: function (data, API, newGraph, retrieveCitations, citing, inputArticlesIds) {
      let incomingSuggestions = this.responseToArray(data, API)
      // OpenCitations always has citations properties, delete to save space
      incomingSuggestions = incomingSuggestions.map(article => { delete article.citations; return article })

      // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
      deepFreeze(incomingSuggestions)
      this.$set(newGraph, 'incomingSuggestions', incomingSuggestions)
      this.saveState()
      if (this.currentGraph === newGraph) this.init()

      /* Perform API call for All / Top Citations (formerly Outgoing suggestions) */
      // Only works with OpenAlex, Semantic Scholar and OpenCitations
      // OA & S2: If all citations are supposed to be retrieved get multiple citations at once based on inputArticlesIds (faster)
      // Otherwise use ids derived from citations
      if (this.retrieveCitations && ['OpenAlex', 'Semantic Scholar', 'OpenCitations'].includes(API)) {
        let outgoingSuggestionsIds
        if (!(retrieveCitations === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API))) {
          outgoingSuggestionsIds = Object.keys(citing)
            // De-duplicate vs inputArticles & incomingSuggestions in case only Top Citations are retrieved
            .filter(x => !inputArticlesIds.includes(x) && !incomingSuggestions.map(x => x.id).includes(x))
            // Sort and slice for Top Citations
            .sort((a, b) => citing[b].length - citing[a].length).slice(0, retrieveCitations)
        }
        this.callAPI((retrieveCitations === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API)) ? inputArticlesIds : outgoingSuggestionsIds, data => this.retrievedOutgoingSuggestions(data, API, newGraph), API, 'citations', false, retrieveCitations === Infinity)
      }
    },
    retrievedOutgoingSuggestions: function (data, API, newGraph) {
      let outgoingSuggestions = this.responseToArray(data, API)
      // OpenCitations always has citations properties, delete to save space
      outgoingSuggestions = outgoingSuggestions.map(article => { delete article.citations; return article })

      // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
      deepFreeze(outgoingSuggestions)
      this.$set(newGraph, 'outgoingSuggestions', outgoingSuggestions)
      this.saveState()

      if (this.currentGraph === newGraph) this.init()
    },
    pushGraph: function (newGraph) {
      // Freeze these large article objects for performance (happens on the first call of init, is ignored afterwards)
      deepFreeze(newGraph.source)
      deepFreeze(newGraph.input)
      deepFreeze(newGraph.incomingSuggestions)
      deepFreeze(newGraph.outgoingSuggestions)
      this.graphs.push(newGraph)

      // Don't keep more articles in tab-bar than maxTabs
      if (this.graphs.length > this.maxTabs) this.graphs = this.graphs.slice(1)

      // Let user explore input articles while suggestions are still loading
      this.setCurrentTabIndex(this.graphs.length - 1)
    },
    clickOpenReferences: function (article) {
      const id = article.id
      const graphSourceIds = this.graphs.map(graph => graph.source.id)

      // If reference is already open in a different tab: change tabs only
      if (graphSourceIds.includes(id)) {
        this.setCurrentTabIndex(graphSourceIds.indexOf(id))
      // Load new source through API when source used different API than currently active
      } else {
        this.newSourceId = String(article.doi)
      }
    },
    clickButtonAdd: function () {
      let message = (this.API === 'OpenAlex')
        ? 'Enter <a href="https://docs.openalex.org/api-entities/works/work-object#ids" target="_blank">DOI / PMID / other ID</a> of new source article'
        : ((this.API === 'Semantic Scholar')
          ? 'Enter <a href="https://api.semanticscholar.org/graph/v1#operation/get_graph_get_paper_references" target="_blank">DOI / PMID / ARXIV / other ID</a> of new source article'
          : 'Enter <a href="https://en.wikipedia.org/wiki/Digital_object_identifier" target="_blank">DOI</a> of new source article')
      if (!this.editListOfIds) message += ' and use its references as input articles. <a onclick="vm.editListOfIds=true; document.querySelector(`footer.modal-card-foot:last-child button`).click()">Enter custom list of IDs instead.</a>'
      this.$buefy.dialog.prompt({
        message: message,
        inputAttrs: {
          placeholder: 'doi:10.1126/SCIENCE.AAC4716',
          maxlength: 50,
          value: this.newSourceId,
          required: null
        },
        onConfirm: value => { this.newSourceId = value }
      })
    },
    clickCloseTab: function (index) {
      // Close tab
      this.graphs.splice(index, 1)
      // If a tab is closed before the selected one or the last tab is selected and closed: update currentTabIndex
      if (this.currentTabIndex > index || this.currentTabIndex > this.graphs.length - 1) {
        if (this.currentTabIndex === 0) this.setCurrentTabIndex(undefined)
        else this.setCurrentTabIndex(this.currentTabIndex - 1)
      }
      this.saveState()
    },
    clickCloseAllTabs: function () {
      this.$buefy.dialog.confirm({
        message: 'Do you want to close all network tabs?',
        type: 'is-danger',
        confirmText: 'Close All',
        onConfirm: () => {
          this.setCurrentTabIndex(undefined)
          this.graphs = []
          this.saveState()
          this.resetBothNetworks()
        }
      })
    },
    highlightNodes: function (selectedAuthorNodeIds = undefined) {
      const network = (this.showAuthorNetwork) ? authorNetwork : citationNetwork

      if (!network) return false

      let selectedNodeIds

      // Co-authorship network
      if (this.showAuthorNetwork) {
        if (selectedAuthorNodeIds) {
          selectedNodeIds = selectedAuthorNodeIds
        // If no nodes are clicked they depend on table selection
        } else if (this.selected) {
          selectedNodeIds = []
          // authorString converts author to full name, as currently used as node id in authorNetwork
          this.selected.authors.map(x => this.authorString([x])).forEach(author => {
            if (network.body.data.nodes.getIds().includes(author)) {
              selectedNodeIds.push(author)
            }
          })
        } else {
          selectedNodeIds = []
        }
      // Citation network
      } else {
        if (this.selected && network.body.data.nodes.getIds().includes(this.selected.id)) {
          selectedNodeIds = [this.selected.id]
        } else {
          selectedNodeIds = []
        }
      }

      network.selectNodes(selectedNodeIds)
      // Only highlight connected nodes in citationNetwork
      const connectedNodes = (!this.showAuthorNetwork) ? network.getConnectedNodes(selectedNodeIds) : []

      // Code loosely adapted from: https://github.com/visjs/vis-network/blob/master/examples/network/exampleApplications/neighbourhoodHighlight.html
      const updatedNodes = network.body.data.nodes.get().map(node => {
        // In citation network the currently selected node should be temporarily maximized for visiblity
        if (!this.showAuthorNetwork) {
          if (selectedNodeIds.includes(node.id)) {
            if (node.cachedValue === undefined) {
              node.cachedValue = node.value
              // Temporarily give selected (and thus highlighted) node the maximum value to match with largest node
              node.value = Math.max.apply(null, citationNetwork.body.data.nodes.get().map(x => x.value))
            }
          } else {
            if (node.cachedValue !== undefined) {
              node.value = node.cachedValue
              node.cachedValue = undefined
            }
          }
        }
        // Show color and label for either highlighted nodes or all nodes if none are highlighted
        if (selectedNodeIds.includes(node.id) || connectedNodes.includes(node.id) || (!selectedNodeIds.length && !this.selected)) {
          node.color = undefined
          if (node.hiddenLabel !== undefined) {
            node.label = node.hiddenLabel
            node.hiddenLabel = undefined
          }
        } else {
          node.color = 'rgba(200,200,200,0.3)'
          if (node.hiddenLabel === undefined) {
            node.hiddenLabel = node.label
            node.label = undefined
          }
        }
        return node
      })

      network.body.data.nodes.update(updatedNodes)
    },
    init: function () {
      this.resetBothNetworks()
      this.initCurrentNetwork()
    },
    resetBothNetworks: function () {
      this.resetCitationNetwork()
      this.resetAuthorNetwork()
    },
    resetCurrentNetwork: function () {
      if (this.showAuthorNetwork) this.resetAuthorNetwork()
      else this.resetCitationNetwork()
    },
    resetCitationNetwork: function () {
      if (citationNetwork) citationNetwork.destroy()
      citationNetwork = undefined
      // Prevent multiple configurators to be added one after another
      document.getElementById('citationNetworkConfigure').innerHTML = ''
    },
    resetAuthorNetwork: function () {
      if (authorNetwork) authorNetwork.destroy()
      authorNetwork = undefined
      // Prevent multiple configurators to be added one after another
      document.getElementById('authorNetworkConfigure').innerHTML = ''
    },
    initCurrentNetwork: function () {
      // Networks are handled by vis.js outside of Vue through these two global init function
      if (this.showAuthorNetwork) initAuthorNetwork(this, this.authorNetworkMinPublications)
      else initCitationNetwork(this, this.currentGraph.minDegreeIncomingSuggestions, this.currentGraph.minDegreeOutgoingSuggestions)
      this.highlightNodes()
    },
    inDegree: function (id) {
      if (id === undefined) return undefined
      return (this.referencedCiting.referenced[id]?.length || 0)
    },
    outDegree: function (id) {
      if (id === undefined) return undefined
      return (this.referencedCiting.citing[id]?.length || 0)
    },
    // compareFunction for array.sort(), in this case descending by default (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort)
    sortInDegree: function (articleA, articleB) {
      let a = this.inDegree(articleA.id) ?? 0
      let b = this.inDegree(articleB.id) ?? 0
      // In case of a tie sort by outDegree secondarily
      if (a === b) {
        a = this.outDegree(articleA.id) ?? 0
        b = this.outDegree(articleB.id) ?? 0
      }
      // In case of another tie sort by year thirdly
      if (a === b) {
        a = articleA.year ?? 0
        b = articleB.year ?? 0
      }
      return a - b
    },
    sortOutDegree: function (articleA, articleB) {
      let a = this.outDegree(articleA.id)
      let b = this.outDegree(articleB.id)
      // In case of a tie sort by inDegree secondarily
      if (a === b) {
        a = this.inDegree(articleA.id)
        b = this.inDegree(articleB.id)
      }
      // In case of another tie sort by year thirdly
      if (a === b) {
        a = articleA.year || 0
        b = articleB.year || 0
      }
      return a - b
    },
    sortReferences: function (articleA, articleB) {
      let a = articleA.referencesCount ?? articleA.references?.length ?? 0
      let b = articleB.referencesCount ?? articleB.references?.length ?? 0
      // In case of a tie sort by inDegree secondarily
      if (a === b) {
        a = this.inDegree(articleA.id)
        b = this.inDegree(articleB.id)
      }
      // In case of another tie sort by year thirdly
      if (a === b) {
        a = articleA.year || 0
        b = articleB.year || 0
      }
      return a - b
    },
    // Wrapper for Buefy tables with third argument "ascending"
    sortInDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortInDegree(a, b) : this.sortInDegree(b, a)
    },
    sortOutDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortOutDegree(a, b) : this.sortOutDegree(b, a)
    },
    sortReferencesWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortReferences(a, b) : this.sortReferences(b, a)
    },
    callAPI: function (ids, responseFunction, API, phase, retrieveAllReferences = false, retrieveAllCitations = false) {
      if (API === 'OpenAlex') {
        return openAlexWrapper(ids, responseFunction, phase, retrieveAllReferences, retrieveAllCitations)
      } else if (API === 'Semantic Scholar') {
        return semanticScholarWrapper(ids, responseFunction, phase, retrieveAllReferences, retrieveAllCitations)
      } else if (API === 'OpenCitations') {
        return openCitationsWrapper(ids, responseFunction, phase)
      } else if (API === 'Crossref') {
        return crossrefWrapper(ids, responseFunction, phase)
      } else {
        return this.errorMessage("Undefined API '" + API + "'. Must be one of 'OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref'.")
      }
    },
    responseToArray: function (data, API) {
      let articles
      if (API === 'Semantic Scholar') {
        articles = semanticScholarResponseToArticleArray(data)
      } else if (API === 'OpenAlex') {
        articles = openAlexResponseToArticleArray(data)
      } else if (API === 'OpenCitations') {
        articles = openCitationsResponseToArticleArray(data)
      } else if (API === 'Crossref') {
        articles = crossrefResponseToArticleArray(data)
      }
      // Remove duplicates - important for de-duplication of All References / All Citations (can be duplicated mostly with S2 but also to lesser extent with OA), rarely also needed for other calls, e.g. for S2 in references of 10.1111/J.1461-0248.2009.01285.X, eebf363bc78ca7bc16a32fa339004d0ad43aa618 came up twice
      articles = articles.reduce((articlesKeep, article) => {
        const articlesKeepIds = articlesKeep.map(x => x.id)
        // Keep placeholders (id undefined) and non-duplicates
        if (article.id === undefined || !articlesKeepIds.includes(article.id)) {
          articlesKeep.push(article)
        } else {
          // S2: All References and All Citations always only have one reference (the one that called them) - merge them on de-duplication
          if (article.references?.length === 1) {
            // This should only occur for All Citations for S2
            if (!articlesKeep[articlesKeepIds.indexOf(article.id)].references.includes(article.references[0])) articlesKeep[articlesKeepIds.indexOf(article.id)].references.push(article.references[0])
          } else if (article.citations?.length === 1) {
            // This should only occur for All References for S2
            if (!articlesKeep[articlesKeepIds.indexOf(article.id)].citations.includes(article.citations[0])) articlesKeep[articlesKeepIds.indexOf(article.id)].citations.push(article.citations[0])
          }
        }
        return articlesKeep
      }, [])
      // Sort article arrays by years, number of references, number of global citations (fairly arbitrary but is never visible)
      articles.sort((a, b) => a.year - b.year || a.references?.length - b.references?.length || a.referencesCount - b.referencesCount || a.referencesCount - b.referencesCount)
      return articles
    },
    errorMessage: function (message) {
      this.$buefy.toast.open({
        message: String(message),
        type: 'is-danger',
        duration: 6000,
        queue: false,
        pauseOnHover: true
      })
    },
    saveState: function (saveGraphs = true, saveSettings = true) {
      if (this.autosaveResults) {
        const maxReferencesCitations = 100
        if (saveGraphs) {
          const copiedGraphs = JSON.parse(JSON.stringify(this.graphs))
          localStorage.graphs = JSON.stringify(copiedGraphs.map(graph => {
            // Delete these two possibly existing flags so that only "Top References" / "Top Citations" instead of "All references" / "All citations" will be shown
            if (graph.incomingSuggestions === undefined || graph.incomingSuggestions.length > maxReferencesCitations) delete graph.allReferences
            if (graph.outgoingSuggestions === undefined || graph.outgoingSuggestions.length > maxReferencesCitations) delete graph.allCitations
            // Don't save suggestions still in loading phase
            // Otherwise suggestions would be saved in loading state (undefined) but after reload they do not continue to load!
            if (graph.incomingSuggestions === undefined) graph.incomingSuggestions = []
            // Only save up to 100 de-duplicated incomingSuggestions (References) & outgoingSuggestions (Citations) for space constraints
            else graph.incomingSuggestions = graph.incomingSuggestions.filter(article => !graph.input.map(x => x.id).includes(article.id)).slice(0, maxReferencesCitations)
            if (graph.outgoingSuggestions === undefined) graph.outgoingSuggestions = []
            else graph.outgoingSuggestions = graph.outgoingSuggestions.filter(article => !graph.input.map(x => x.id).includes(article.id) && !graph.incomingSuggestions.map(x => x.id).includes(article.id)).slice(0, maxReferencesCitations)

            return graph
          }))
        }
        if (saveSettings) {
          localStorage.autosaveResults = true
          localStorage.API = this.API
          localStorage.retrieveReferences = this.retrieveReferences
          localStorage.retrieveCitations = this.retrieveCitations
          localStorage.semanticScholarAPIKey = this.semanticScholarAPIKey
        }
      } else {
        localStorage.clear()
      }
    },
    filterArticles: function (articles) {
      if (!this.filterString) return articles
      const re = new RegExp(this.filterString, 'gi')
      let ids
      switch (this.filterColumn) {
        case 'titleAbstract':
          return articles.filter(article =>
            (String(article.numberInSourceReferences).match(new RegExp(this.filterString, 'y'))) ||
            (article.id?.match(re)) ||
            (article.doi?.match(re)) ||
            (article.title?.match(re)) ||
            (article.abstract?.match(re))
          )
        case 'authors':
          return articles.filter(article => this.authorString(article.authors).match(re) || article.authors.map(author => author.affil?.match(re)).some(Boolean))
        case 'year':
          return articles.filter(article => String(article.year).match(re))
        case 'journal':
          return articles.filter(article => String(article.journal).match(re))
        case 'citedById':
          ids = this.referencedCiting.citing[this.filterString]
          return articles.filter(article => ids?.includes(article.id))
        case 'citingId':
          ids = this.referencedCiting.referenced[this.filterString]
          return articles.filter(article => ids?.includes(article.id))
        case 'citedByInputArticleId':
          return this.citedByInputArticleId(articles, this.filterString)
        case 'citesInputArticleId':
          return this.citesInputArticleId(articles, this.filterString)
        default:
          return articles
      }
    },
    citedByInputArticleId: function (articles, inputArticleId) {
      const ids = this.currentGraph.input[this.inputArticlesIds.indexOf(inputArticleId)]?.references
      return articles.filter(article => ids?.includes(article.id))
    },
    citesInputArticleId: function (articles, inputArticleId) {
      return articles.filter(article => article.references.includes(inputArticleId))
    },
    authorString: function (authors) {
      return (authors?.length) ? authors.map(x => ((x.FN) ? (x.FN) + ' ' : '') + x.LN).join(', ') : ''
    },
    authorStringShort: function (authors) {
      return (authors?.length > 5) ? this.authorString(authors.slice(0, 5).concat({ LN: '(' + (authors.length - 5) + ' more)' })) : this.authorString(authors)
    },
    clickToggleAutosave: function () {
      this.autosaveResults = !this.autosaveResults
      this.saveState()
      this.$buefy.toast.open({
        message: (this.autosaveResults) ? 'Local autosave on' : 'Local autosave off',
        type: (this.autosaveResults) ? 'is-success' : 'is-danger',
        queue: false
      })
    },
    addGraphs: function (graphs) {
      const graphTabLabels = this.graphs.map(x => x.tabLabel)
      for (const graph of graphs) {
        if (!graphTabLabels.includes(graph.tabLabel)) {
          // Prior to v1.23 referenced and citing were cached in the graph object
          delete graph.referenced
          delete graph.citing
          this.pushGraph(graph)
        } else {
          this.errorMessage("Tab with name '" + graph.tabLabel + "' already exists!")
        }
      }
    },
    loadGraphsFromJSON: function (path) {
      this.isLoading = true
      // If path is neither "examples.json" nor a URL, check hardcoded path for "cache"
      if (path !== 'examples.json' && !(path.startsWith('https://') || path.startsWith('http://'))) {
        path = 'https://raw.githubusercontent.com/LocalCitationNetwork/cache/main/' + path
      }
      fetch(path).then(data => data.json()).then(graphs => {
        this.addGraphs(graphs)
        vm.saveState()
        this.isLoading = false
      }).catch(e => {
        this.isLoading = false
        this.errorMessage('Could not load cached networks from ' + path + ': ' + e)
      })
    },
    toggleArticle: function () {
      // Same condition as in :has-detailed-visible
      if (this.selected.authors.length || this.inDegree(this.selected.id) || this.outDegree(this.selected.id) || this.selected.abstract || this.selected.tldr) {
        this.$refs[this.showArticlesTab + 'Table'].toggleDetails(this.selected)
      }
    },
    tableArrowUpChangePage: function () {
      if (this[this.showArticlesTab + 'TablePage'] > 1 && (this.$refs[this.showArticlesTab + 'Table'].newData.indexOf(this.selected) + 1) % vm.articlesPerPage === 1) {
        this[this.showArticlesTab + 'TablePage'] -= 1
      }
    },
    tableArrowDownChangePage: function () {
      const maxPage = Math.ceil(this.$refs[this.showArticlesTab + 'Table'].newData.length / vm.articlesPerPage)
      if (this[this.showArticlesTab + 'TablePage'] < maxPage && (this.$refs[this.showArticlesTab + 'Table'].newData.indexOf(this.selected) + 1) % vm.articlesPerPage === 0) {
        this[this.showArticlesTab + 'TablePage'] += 1
      }
    },
    formatTags: function (text) {
      // 'a' tags only without attributes for blue color in network tooltips!
      const tags = ['a', 'b', 'br', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'p', 'subtitle', 'sup', 'u']
      text = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      tags.forEach(tag => {
        text = text.replaceAll(new RegExp('&lt;' + tag + '&gt;', 'gi'), '<' + tag + '>')
        text = text.replaceAll(new RegExp('&lt;/' + tag + '&gt;', 'gi'), '</' + tag + '>')
      })
      text = text.replaceAll('\n', '<br>')
      return text
    },
    importList: function () {
      if (['OpenCitations', 'Crossref'].includes(this.API)) {
        if (!this.listOfIds.filter(Boolean).every(x => x.match(/10\.\d{4,9}\/\S+/))) return this.errorMessage('For ' + this.API + ', all IDs must be valid DOIs, try other API.')
        this.listOfIds = this.listOfIds.map(x => x ? x.match(/10\.\d{4,9}\/\S+/)[0] : undefined)
      }
      // Remove observer attributes from listOfIds and deepFreeze
      const listOfIds = deepFreeze(JSON.parse(JSON.stringify(this.listOfIds)))
      if (this.newSourceId) {
        this.setNewSource(this.newSourceId, listOfIds)
      } else {
        this.createNewNetwork({ references: listOfIds, citations: [] })
      }
      this.listOfIds = undefined
      this.editListOfIds = false
    },
    abbreviateAPI: function (API) {
      switch (API) {
        case 'OpenAlex': return 'OA'
        case 'Semantic Scholar': return 'S2'
        case 'OpenCitations': return 'OC'
        case 'Crossref': return 'CR'
      }
    },
    articleLink: function (article) {
      if (article.doi) return 'https://doi.org/' + article.doi
      else if (this.currentGraph.API === 'OpenAlex' && article.id) return 'https://openalex.org/' + article.id
      else if (this.currentGraph.API === 'Semantic Scholar' && article.id) return 'https://semanticscholar.org/paper/' + article.id
      else return false
    },
    referencesLink: function (article) {
      if (this.currentGraph.API === 'OpenAlex' && article.id) return 'https://openalex.org/works?page=1&filter=cited_by:' + article.id
      else if (this.currentGraph.API === 'Semantic Scholar' && article.id) return 'https://semanticscholar.org/paper/' + article.id + '#cited-papers'
      else return false
    },
    citationsLink: function (article) {
      if (this.currentGraph.API === 'OpenAlex' && article.id) return 'https://openalex.org/works?page=1&filter=cites:' + article.id
      else if (this.currentGraph.API === 'Semantic Scholar' && article.id) return 'https://semanticscholar.org/paper/' + article.id + '#citing-papers'
      else return false
    },
    authorLink: function (author) {
      if (author.orcid) return 'https://orcid.org/' + author.orcid
      else if (Number(author.id.substr(1)) && this.currentGraph.API === 'OpenAlex') return 'https://openalex.org/' + author.id
      else if (Number(author.id) && this.currentGraph.API === 'Semantic Scholar') return 'https://semanticscholar.org/author/' + author.id
      else return 'https://scholar.google.com/scholar?q=' + author.name
    },
    changeCurrentNetworkSettings: function () {
      if (this.fullscreenTable) return false
      this.resetCurrentNetwork()
      this.initCurrentNetwork()
      this.saveState(false)
    },
    downloadCSVData: function (articlesArray) {
      function prepareCell (text) {
        if (!text) return ''
        if (typeof (text) === 'object') text = text.join(', ')
        else text = String(text)
        while (text[0] === '=') text = text.substring(1)
        // Use double-quotes to escape quotes: https://stackoverflow.com/questions/17808511/how-to-properly-escape-a-double-quote-in-csv
        return text.replaceAll('"', '""')
      }

      let csv = 'sep=;\n'
      csv += '"# https://LocalCitationNetwork.github.io/' + this.linkToShareAppendix + '"\n'
      csv += '"# Data retrieved through ' + this.currentGraph.API + ' (' + this.abbreviateAPI(this.currentGraph.API) + ') on ' + new Date(this.currentGraph.timestamp).toLocaleString() + '"\n'
      csv += '"id";"doi";' + ((this.showArticlesTab === 'inputArticles' && this.showNumberInSourceReferences) ? '"#";' : '') + '"type";"title";"authors";"journal";"year";"date";"volume";"issue";"firstPage";"lastPage";"abstract";"globalCitationsCount";"localInDegree";"localOutDegree";"referencesCount";"localIncomingCitations";"localOutgoingCitations";"references"\n'
      csv += articlesArray.map(row => {
        let arr = [row.id, row.doi, (this.showArticlesTab === 'inputArticles' && this.showNumberInSourceReferences) ? row.numberInSourceReferences : false, row.type, row.title, this.authorString(row.authors), row.journal, row.year, row.date, row.volume, row.issue, row.firstPage, row.lastPage, row.abstract, row.citationsCount, this.inDegree(row.id), this.outDegree(row.id), row.references.length, this.referencedCiting.referenced[row.id], this.referencedCiting.citing[row.id], row.references]
        arr = arr.filter(x => x !== false).map(x => prepareCell(x))
        return '"' + arr.join('";"') + '"'
      }).join('\n')

      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${vm.currentGraph.tabLabel} ${vm.showArticlesTab}.csv`
      anchor.click()
      anchor.remove()
    },
    downloadRISData: function (articlesArray) {
      // TODO consider mapping types to RIS types instead of always using "TY  - JOUR" (journal article)
      // OpenAlex types: https://api.openalex.org/works?group_by=type
      // RIS Types: https://en.wikipedia.org/wiki/RIS_(file_format)#Type_of_reference
      let ris = ''
      articlesArray.forEach(row => {
        ris += 'TY  - JOUR\n'
        ris += 'ID  - ' + row.id + '\n'
        ris += 'DO  - ' + row.doi + '\n'
        ris += 'TI  - ' + row.title + '\n'
        for (const author of row.authors) {
          ris += 'AU  - ' + author.LN + ', ' + author.FN + '\n'
        }
        if (row.journal) ris += 'JO  - ' + row.journal + '\n'
        if (row.year) ris += 'PY  - ' + row.year + '\n'
        if (row.volume) ris += 'VL  - ' + row.volume + '\n'
        if (row.issue) ris += 'IS  - ' + row.issue + '\n'
        if (row.firstPage)ris += 'SP  - ' + row.firstPage + '\n'
        if (row.lastPage) ris += 'EP  - ' + row.lastPage + '\n'
        if (row.abstract) ris += 'AB  - ' + row.abstract + '\n'
        ris += 'ER  - \n\n'
      })

      const blob = new Blob([ris], { type: 'application/x-research-info-systems' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${vm.currentGraph.tabLabel} ${vm.showArticlesTab}.ris`
      anchor.click()
      anchor.remove()
    },
    downloadJSON: function () {
      const blob = new Blob([JSON.stringify([vm.currentGraph])], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${vm.currentGraph.tabLabel}.json`
      anchor.click()
      anchor.remove()
    }
  },
  mounted: function () {
    const urlParams = new URLSearchParams(window.location.search)

    // Load locally saved networks / settings from localStorage
    try {
      if (localStorage.graphs) this.addGraphs(JSON.parse(localStorage.graphs))
      if (localStorage.autosaveResults) this.autosaveResults = localStorage.autosaveResults === 'true'
      if (localStorage.API && ['OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref'].includes(localStorage.API)) this.API = localStorage.API
      if (!isNaN(Number(localStorage.retrieveReferences))) this.retrieveReferences = Number(localStorage.retrieveReferences)
      if (!isNaN(Number(localStorage.retrieveCitations))) this.retrieveCitations = Number(localStorage.retrieveCitations)
      if (localStorage.semanticScholarAPIKey) this.semanticScholarAPIKey = localStorage.semanticScholarAPIKey
    } catch (e) {
      localStorage.clear()
      console.log('Could not load locally saved networks / settings.')
      console.log(e)
    }

    // Set API according to link
    if (urlParams.has('API') && ['OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref'].includes(urlParams.get('API'))) {
      this.API = urlParams.get('API')
    }

    // Open editListOfIds modal from link / bookmarklet
    if (urlParams.has('listOfIds')) {
      // Safety measure to allow max. 500 Ids
      const DOIs = urlParams.get('listOfIds').split(',')
        .slice(0, 500)
        .map(id => (id.match(/10\.\d{4,9}\/\S+/)) ? id.match(/10\.\d{4,9}\/\S+/)[0].toUpperCase() : id)

      this.listOfIds = DOIs
      this.listName = urlParams.has('name') ? urlParams.get('name') : 'Custom'
      this.bookmarkletURL = urlParams.has('bookmarkletURL') ? urlParams.get('bookmarkletURL') : undefined
      if (urlParams.has('source')) this.newSourceId = urlParams.get('source')
      this.editListOfIds = true
    // Load new source from link
    } else if (urlParams.has('source')) {
      const id = urlParams.get('source')
      const graphSourceIds = this.graphs.map(graph => graph.source.id)
      const graphSourceDOIs = this.graphs.map(graph => graph.source.doi)

      // Only if reference is not already open in a different tab with same API (setting to correct tab via this.currentTabIndex = X doesn't work because it is initialized to default afterwards)
      if (
        !(graphSourceIds.includes(id) && this.graphs[graphSourceIds.indexOf(id)].API === this.API) &&
        !(graphSourceDOIs.includes(id.toUpperCase()) && this.graphs[graphSourceDOIs.indexOf(id.toUpperCase())].API === this.API)
      ) {
        this.newSourceId = id
      }
    // Linked to a JSON file cached somewhere?
    } else if (urlParams.has('fromJSON')) {
      this.loadGraphsFromJSON(urlParams.get('fromJSON'))
    // Linked to examples? Only load when no other graphs are opened
    } else if (!this.isLoading && !this.editListOfIds && this.graphs.length === 0 && urlParams.has('examples')) {
      this.loadGraphsFromJSON('examples.json')
    }

    // Linked to FAQ?
    if (window.location.hash.length) {
      this.showFAQ = true
      this.indexFAQ = window.location.hash.substr(1)
    }
  }
})
