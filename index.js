/* Local Citation Network (GPL-3) */
/* by Tim Woelfle */
/* https://LocalCitationNetwork.github.io */

/* global fetch, localStorage, vis, Vue, Buefy */

'use strict'

const localCitationNetworkVersion = 1.21

/*
For now, old terminology is kept in-code because of back-compatibility with old saved graphs objects (localStorage & JSON)
"incomingSuggestions" are now "topReferences"
"outgoingSuggestions" are now "topCitations"
*/

const arrSum = arr => arr.reduce((a, b) => a + b, 0)
const arrAvg = arr => arrSum(arr) / arr.length
const arrSort = (arr, fun, ascending = true) => arr.sort((b, a) => (ascending) ? fun(b) - fun(a) : fun(a) - fun(b))

/* Semantic Scholar API */
// https://api.semanticscholar.org/api-docs/graph#tag/paper

async function semanticScholarWrapper (ids, responseFunction, phase, retrieveAllReferences = false, retrieveAllCitations = false) {
  let responses = []

  ids = ids.map(id => {
    if (!id) return undefined
    else if (!isNaN(Number(id))) return 'pmid:' + id
    else return id
  })

  let selectFields = 'externalIds,title,abstract,journal,venue,year,referenceCount,citationCount,publicationTypes,publicationDate'

  let id, response
  const sourceInput = ['source', 'input'].includes(phase)

  if ((phase === 'references' && retrieveAllReferences) || (phase === 'citations' && retrieveAllCitations)) selectFields += ',authors'
  else {
    selectFields += ',authors.externalIds,authors.name,authors.affiliations,references.paperId'
    // Get citations ids for input articles (if not all citations are retrieved anyway)
    if (sourceInput && !retrieveAllCitations) selectFields += ',citations.paperId'
  }

  // TODO Experiment with API POST batch endpoint for faster performance? https://api.semanticscholar.org/api-docs/graph#tag/Paper-Data/operation/post_graph_get_papers
  vm.isLoadingTotal = ids.length
  for (const i of Array(ids.length).keys()) {
    id = ids[i]
    response = undefined
    vm.isLoadingIndex = i
    if (id) {
      // Use "references" / "citations" API endpoints instead of a a single query for each reference / citation for "Retrieve references / citations: All" (faster)
      if ((phase === 'references' && retrieveAllReferences) || (phase === 'citations' && retrieveAllCitations)) {
        // TODO: Citation results are incomplete when a paper is cited by >1000 (current upper-limit of S2); for now use OpenAlex for completeness
        response = await semanticScholarPaper(id + '/' + phase + '?limit=1000&fields=' + selectFields)
        response = response.data.map(x => x.citedPaper || x.citingPaper) // citedPaper for references, citingPaper for citations
        if (phase === 'citations') {
          response = response.map(x => { x.references = [{ paperId: id }]; return x })
        }
      } else {
        // TODO: Citation results are incomplete when a paper is cited by >1000 (current upper-limit of S2); for now use OpenAlex for completeness
        response = await semanticScholarPaper(id + '?fields=' + selectFields)
        // Get referenceContexts for source
        if (phase === 'source') {
          const referenceContexts = await semanticScholarPaper(id + '/references?limit=1000&fields=paperId,contexts')
          if (referenceContexts) response.referenceContexts = referenceContexts
        }
        // TODO Add placeholders for missing items with missingReason (e.g. response.statusText)
        // if (!response) response = {'id': id, 'title': 'missing: ' + id}
      }
    }
    responses = responses.concat(response)
  }
  vm.isLoadingTotal = 0
  responseFunction(responses)
}

function semanticScholarPaper (suffix) {
  return fetch('https://api.semanticscholar.org/graph/v1/paper/' + suffix).then(response => {
    if (!response.ok) throw (response)
    return response.json()
  }).catch(async function (response) {
    // "Too Many Requests" errors (status 429) are unfortunately sometimes sent with wrong CORS header and thus cannot be distinguished from generic network errors
    if (response.status === 429 || typeof response.statusText !== 'string') {
      if (response.status === 429) vm.errorMessage('Semantic Scholar (S2) reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('Semantic Scholar (S2) not reachable, probably too rapid requests. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return semanticScholarPaper(suffix)
    }
    vm.errorMessage('Error while processing data through Semantic Scholar API for ' + suffix.replace(/\?.*/, '') + ': ' + response.statusText + ' (' + response.status + ')')
    return false
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
      references: (article.references) ? article.references.map(x => x.paperId) : [],
      referencesCount: article.referenceCount,
      citations: (article.citations) ? article.citations.map(x => x.paperId).filter(Boolean) : [],
      citationsCount: article.citationCount,
      abstract: article.abstract,
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
    else if (!isNaN(Number(id))) return 'pmid:' + id
    else return 'openalex:' + id
  })

  const selectFields = 'id,doi,display_name,authorships,publication_year,primary_location,biblio,referenced_works,cited_by_count,abstract_inverted_index,is_retracted,type,publication_date'

  let id, cursor, response
  const sourceInput = ['source', 'input'].includes(phase)
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
  } else {
    vm.isLoadingTotal = ids.length
    for (const i of Array(ids.length).keys()) {
      id = ids[i]
      response = undefined
      vm.isLoadingIndex = i
      if (id) {
        response = await openAlexWorks('/' + id.replace('openalex:', '') + '?select=' + selectFields)
        // Get citations ids for input articles (if not all citations are retrieved anyway)
        if (sourceInput && response.id && !retrieveAllCitations) {
          // Careful: Citation results are incomplete when a paper is cited by >200 (current per-page upper-limit of OA), use "API options => Retrieve citations => All" for completeness
          const citations = await openAlexWorks('?select=id&per-page=200&sort=referenced_works_count:desc&filter=cites:' + response.id.replace('https://openalex.org/', ''))
          if (citations) { response.citations = citations }
        }
      }
      // TODO Add placeholders for missing items with missingReason (e.g. response.statusText)
      // if (!response) response = {'id': id?.replace('openalex:', ''), 'display_name': 'missing: ' + id?.replace('openalex:', '')}
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
    vm.errorMessage('Error while processing data through OpenAlex API for ' + suffix.substr(1).replace(/\?.*/, '') + ': ' + response.statusText)
    return false
  })
}

function openAlexResponseToArticleArray (data) {
  return data.filter(Boolean).map(article => {
    const doi = (article.doi) ? article.doi.replace('https://doi.org/', '').toUpperCase() : undefined

    return {
      id: article.id?.replace('https://openalex.org/', ''),
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      type: article.type,
      title: article.display_name || '',
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
      journal: article.primary_location?.source?.display_name +
        ((article.primary_location?.source?.host_organization_name && !article.primary_location?.source?.display_name?.includes(article.primary_location.source?.host_organization_name)) ? ' (' + article.primary_location?.source?.host_organization_name + ')' : ''),
      volume: article.biblio?.volume,
      issue: article.biblio?.issue,
      firstPage: article.biblio?.first_page,
      lastPage: article.biblio?.last_page,
      references: (article.referenced_works || []).map(x => x.replace('https://openalex.org/', '')),
      citations: (article.citations) ? article.citations.results.map(x => x.id.replace('https://openalex.org/', '')) : [],
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
    // TODO Add placeholders for missing inputs with missingReason (e.g. response.statusText)
    // if (!response) response = {'id': id, 'title': 'missing: ' + id}
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
    if (typeof data !== 'object' || !data.message || !data.message.items || !data.message.items[0]) throw ({ statusText: 'Empty response.' })
    return (data.message.items[0])
  }).catch(async function (response) {
    if (response.status === 429 || typeof response.statusText !== 'string') {
      if (response.status === 429) vm.errorMessage('Crossref reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('Crossref not reachable. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return crossrefWorks(id)
    }
    vm.errorMessage('Error while processing data through Crossref API for ' + id + ': ' + response.statusText)
    return false
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
      year: article.issued['date-parts']?.[0]?.[0],
      date: (article.issued['date-parts']?.[0]?.[0]) ? formatDate(article.issued['date-parts'][0][0], article.issued['date-parts'][0][1], article.issued['date-parts'][0][2]) : undefined,
      journal: String(article['container-title']),
      // Crossref "references" array contains null positions for references it doesn't have DOIs for, thus preserving the original number of references
      references: (typeof article.reference === 'object') ? article.reference.map(x => (x.DOI) ? x.DOI.toUpperCase() : undefined) : [],
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
    // TODO Add placeholders for missing items with missingReason (e.g. response.statusText)
    // if (!response) response = {'id': id, 'title': 'missing: ' + id}
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
    if (typeof data !== 'object' || !data.length) throw ({ statusText: 'Empty response.' })
    return data
  }).catch(async function (response) {
    if (response.status === 429 || typeof response.statusText !== 'string') {
      if (response.status === 429) vm.errorMessage('OpenCitations (OC) reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('OpenCitations (OC) not reachable. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return openCitationsMetadata(id)
    }
    vm.errorMessage('Error while processing data through OpenCitations API for ' + id + ': ' + response.statusText)
    return false
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
      authors: article.author.split('; ').map(x => ({ LN: x.split(', ')[0], FN: x.split(', ')[1] })),
      year: article.year,
      journal: String(article.source_title),
      volume: article.volume,
      issue: article.issue,
      firstPage: article.page?.split('-')?.[0],
      lastPage: article.page?.split('-')?.[1],
      references: (article.reference) ? article.reference.split('; ').map(x => (x) ? x.toUpperCase() : undefined) : [],
      citations: (article.citation) ? article.citation.split('; ').map(x => x.toUpperCase()) : [],
      citationsCount: Number(article.citation_count)
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

function initCitationNetwork (app, minDegreeIncomingSuggestions = 2, minDegreeOutgoingSuggestions = 2) {
  // This line is necessary because of v-if="currentTabIndex !== undefined" in the main columns div, which apparently is evaluated after watch:currentTabIndex is called
  if (!document.getElementById('citationNetwork')) return setTimeout(function () { app.init() }, 1)

  // Only init network if it doesn't exist yet (or was previously reset == destroyed)
  if (document.getElementById('citationNetwork').innerHTML !== '') return false

  app.citationNetworkIsLoading = true

  // Filter articles (must have year (for hierarchical layout))
  const inputArticles = app.currentGraph.input.filter(article => (app.citationNetworkShowSource ? true : !article.isSource)).filter(article => article.year)
  const incomingSuggestions = (app.currentGraph.incomingSuggestions ?? [])
    .slice(0, app.maxIncomingSuggestions)
    .filter(article => article.year)
    .filter(article => app.inDegree(article.id) + app.outDegree(article.id) >= minDegreeIncomingSuggestions)
  const outgoingSuggestions = (app.currentGraph.outgoingSuggestions ?? [])
    .slice(0, app.maxOutgoingSuggestions)
    .filter(article => article.year)
    .filter(article => app.inDegree(article.id) + app.outDegree(article.id) >= minDegreeOutgoingSuggestions)

  // Create an array with edges
  // Only keep connected articles (no singletons)
  let articles = new Set()
  let edges = inputArticles.map(article => {
    return (!app.currentGraph.referenced[article.id]) ? [] : app.currentGraph.referenced[article.id].map(x => {
      if (inputArticles.map(x => x.id).includes(x)) {
        articles.add(article)
        articles.add(inputArticles[inputArticles.map(x => x.id).indexOf(x)])
        return { from: x, to: article.id }
      } else {
        console.log("This shouldn't happen")
      }
    })
  }).flat()
  edges = edges.concat(incomingSuggestions.concat(outgoingSuggestions).map(article => {
    return (!app.currentGraph.referenced[article.id]) ? [] : app.currentGraph.referenced[article.id].map(x => {
      if (inputArticles.map(x => x.id).includes(x)) {
        articles.add(article)
        articles.add(inputArticles[inputArticles.map(x => x.id).indexOf(x)])
        return { from: x, to: article.id }
      } else {
        console.log("This shouldn't happen")
      }
    })
  }).flat())
  edges = edges.concat(incomingSuggestions.concat(outgoingSuggestions).map(article => {
    return (!app.currentGraph.citing[article.id]) ? [] : app.currentGraph.citing[article.id].map(x => {
      if (inputArticles.map(x => x.id).includes(x)) {
        articles.add(article)
        articles.add(inputArticles[inputArticles.map(x => x.id).indexOf(x)])
        return { from: article.id, to: x }
      } else {
        console.log("This shouldn't happen")
      }
    })
  }).flat())

  articles = Array.from(articles)

  if (!articles.length) {
    app.citationNetworkIsLoading = false
  }

  // Sort by rank of year
  const years = Array.from(new Set(articles.map(article => article?.year).sort()))

  const nodes = articles.map(article => ({
    id: article.id,
    title: htmlTitle(app.authorStringShort(article.authors) + '. <a><em>' + article.title + '</em></a>. ' + article.journal + '. ' + article.year + '.<br>(Double click opens article: <a>' + String(app.articleLink(article)).substr(0, 28) + '...</a>)'),
    level: years.indexOf(article.year),
    group: article[app.citationNetworkNodeColor],
    value: arrSum([['in', 'both'].includes(app.citationNetworkNodeSize) ? app.inDegree(article.id) : 0, ['out', 'both'].includes(app.citationNetworkNodeSize) ? app.outDegree(article.id) : 0]),
    shape: (app.currentGraph.source.id === article.id) ? 'diamond' : (app.inputArticlesIds.includes(article.id) ? 'dot' : (app.incomingSuggestionsIds.includes(article.id) ? 'triangle' : 'triangleDown')),
    label: article.authors[0]?.LN + '\n' + article.year
  }))

  // Create network
  const options = {
    layout: {
      hierarchical: {
        direction: (app.currentGraph.citationNetworkTurned) ? 'LR' : 'DU',
        levelSeparation: 400
      }
    },
    nodes: {
      font: {
        strokeWidth: 30,
        strokeColor: '#eeeeee'
      },
      scaling: {
        min: 30,
        max: 300,
        label: {
          enabled: true,
          min: 50,
          max: 250,
          maxVisible: 30,
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
          scaleFactor: 4
        }
      },
      width: 8,
      smooth: false
      // chosen: { edge: function(values, id, selected, hovering) { values.inheritsColor = "from" } },
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
        nodeDistance: 700
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
  let articles = JSON.parse(JSON.stringify(app.currentGraph.input))
  articles = arrSort(articles, x => x.year, app.authorNetworkNodeColor === 'firstArticle')

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
    API: 'OpenAlex', // Options: 'OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref' ('Microsoft Academic' was discontinued 01/2022)
    retrieveReferences: 10,
    retrieveCitations: 10,
    maxTabs: 5,
    autosaveResults: false,

    // Data
    graphs: [],
    newSource: undefined,
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
    showCitationNetworkSettings: true,
    showAuthorNetworkSettings: true,
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
      return this.filterArticles(this.currentGraph.input)
    },
    incomingSuggestionsFiltered: function () {
      return this.filterArticles(this.currentGraph.incomingSuggestions ?? [])
    },
    outgoingSuggestionsFiltered: function () {
      return this.filterArticles(this.currentGraph.outgoingSuggestions ?? [])
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
            if (x) this.inputArticlesTablePage = Math.ceil((this.$refs.inputArticlesTable.newData.indexOf(x) + 1) / 10)
            break
          case 'topReferences':
            this.selectedIncomingSuggestionsArticle = x
            if (x) this.topReferencesTablePage = Math.ceil((this.$refs.topReferencesTable.newData.indexOf(x) + 1) / 10)
            break
          case 'topCitations':
            this.selectedOutgoingSuggestionsArticle = x
            if (x) this.topCitationsTablePage = Math.ceil((this.$refs.topCitationsTable.newData.indexOf(x) + 1) / 10)
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
      get: function () { return this.currentGraph.minDegreeIncomingSuggestions ?? 2 },
      set: function (x) { this.$set(this.currentGraph, 'minDegreeIncomingSuggestions', Number(x)) }
    },
    minDegreeOutgoingSuggestions: {
      get: function () { return this.currentGraph.minDegreeOutgoingSuggestions ?? 2 },
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
      return this.currentGraph.input.filter(article => !article.isSource)
    },
    completenessOriginalReferencesFraction: function () {
      return this.completenessInputArticlesWithoutSource.length / this.completenessOriginalReferencesCount
    },
    completenessInputHasReferences: function () {
      return arrSum(this.completenessInputArticlesWithoutSource.map(x => x.references.length !== 0))
    },
    completenessInputReferencesFraction: function () {
      return arrAvg(this.completenessInputArticlesWithoutSource.filter(x => x.references.length !== 0).map(x => x.references.filter(Boolean).length / x.references.length))
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
    // Initialize graph when new tab is opened / tab is changed
    currentTabIndex: function () {
      // Reset filterString when tab is changed
      this.filterString = undefined

      // Don't know how to prevent this from firing (and thus causing a reinit) when closing a tab to the left of the selected article (only noticeable by a short flicker of the network, thus not a real issue)
      if (this.graphs.length) {
        this.init()
      }
    },
    // User provided a new DOI or other id for source article
    newSource: function () {
      if (!this.newSource || !this.newSource.replaceAll(/\s/g, '')) return false

      this.newSource = this.newSource.replaceAll(/\s/g, '').replace(/DOI:|https:\/\/doi.org\//i, '')

      // OpenCitations and Crossref only allow DOIs as ids
      if (['OpenCitations', 'Crossref'].includes(this.API)) {
        if (this.newSource.match(/10\.\d{4,9}\/\S+/)) this.newSource = this.newSource.match(/10\.\d{4,9}\/\S+/)[0]
        else return this.errorMessage(this.newSource + ' is not a valid DOI, which must be in the form: 10.prefix/suffix where prefix is 4 or more digits and suffix is a string.')
      }

      if (!this.editListOfIds && !this.isLoading) this.setNewSource(this.newSource)
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
            this.addGraphsFromJSON(graphs)
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
    }
  },
  methods: {
    setNewSource: function (id, customListOfReferences = undefined) {
      this.isLoading = true

      const API = this.API
      this.callAPI([id], data => {
        const source = this.responseToArray(data, API)[0]
        if (source && customListOfReferences) {
          source.references = customListOfReferences
          source.customListOfReferences = customListOfReferences
        }
        this.createNewNetwork(source)
      }, API, 'source')
    },
    createNewNetwork: function (source) {
      // Reset newSource (otherwise it cannot be called twice in a row with different APIs)
      this.newSource = undefined

      // Some papers can be found in the APIs but don't have references themselves in there
      if (!source) {
        this.isLoading = false
        return this.errorMessage(`Source not found in ${this.API} API, try other API.`)
      }
      if (!source.references.length) {
        this.isLoading = false
        return this.errorMessage(`No references found for source in ${this.API} API, try other API.`)
      }

      // In case of file scanning, isLoading has not yet been set by setNewSource
      this.isLoading = true

      this.$buefy.toast.open({
        message: 'New query sent to ' + this.API + '.<br>This may take a while, depending on the number of references and API workload.',
        duration: 6000,
        queue: false
      })

      // Get Input articles
      const API = this.API
      const retrieveReferences = this.retrieveReferences
      const retrieveCitations = this.retrieveCitations
      this.callAPI(source.references, data => {
        source.isSource = true
        const referenced = {}
        const citing = {}
        let inputArticles = this.responseToArray(data, API)

        // If source has customListOfReferences its references must be updated to match id format of API (otherwise inDegree and outDegree and network don't work correctly)
        // Original list will be kept in source.customListOfReferences
        if (source.customListOfReferences) {
          source.references = inputArticles.map(article => article.id)
        }

        // Don't put source in inputArticles when a list without source was loaded
        const inputArticlesIdsWithoutSource = inputArticles.map(article => article.id)
        if (source.id) inputArticles = inputArticles.concat(source)
        const inputArticlesIds = inputArticles.map(article => article.id)

        // Populate referenced and citing objects
        function populateReferencedCiting (articles) {
          articles.forEach(article => {
            // Avoid duplicate counting of references for in-degree (e.g. https://api.crossref.org/works/10.7717/PEERJ.3544 has 5 references to DOI 10.1080/00031305.2016.1154108)
            article.references.filter(Boolean).forEach(refId => {
              if (inputArticlesIds.includes(article.id)) {
                if (!referenced[refId]) referenced[refId] = []
                if (!referenced[refId].includes(article.id)) referenced[refId].push(article.id)
              }
              if (inputArticlesIds.includes(refId)) {
                if (!citing[article.id]) citing[article.id] = []
                if (!citing[article.id].includes(refId)) citing[article.id].push(refId)
              }
            })
            article.citations?.filter(Boolean).forEach(citId => {
              /* This part wouldn't add any references because they're already covered above
              if (inputArticlesIds.includes(citId)) {
                if (!referenced[article.id]) referenced[article.id] = []
                if (!referenced[article.id].includes(citId)) referenced[article.id].push(citId)
              } */
              if (inputArticlesIds.includes(article.id)) {
                if (!citing[citId]) citing[citId] = []
                if (!citing[citId].includes(article.id)) citing[citId].push(article.id)
              }
            })
            // Remove citations properties to save space because the information is now stored in "citing" (otherwise localStorage quota exceeds sooner)
            delete articles[articles.indexOf(article)].citations
          })
        }
        function reduceObject (object, ids) {
          return ids.reduce((newObject, id) => { newObject[id] = object[id]; return newObject }, {})
        }
        populateReferencedCiting(inputArticles)

        // Add new tab
        const newGraph = {
          source: source,
          input: inputArticles,
          incomingSuggestions: (retrieveReferences) ? undefined : [],
          outgoingSuggestions: (retrieveCitations && API !== 'Crossref') ? undefined : [],
          referenced: reduceObject(referenced, inputArticlesIds),
          citing: reduceObject(citing, inputArticlesIds),
          tabLabel: source.id ? ((source.authors[0] && source.authors[0].LN) + ' ' + source.year) : this.listName,
          tabTitle: source.id ? source.title : this.listName,
          bookmarkletURL: this.bookmarkletURL,
          API: API,
          timestamp: Date.now(),
          localCitationNetworkVersion: localCitationNetworkVersion
        }
        if (retrieveReferences === Infinity) newGraph.allReferences = true
        if (retrieveCitations === Infinity) newGraph.allCitations = true
        this.pushGraph(newGraph)
        this.isLoading = false
        this.listName = undefined
        this.bookmarkletURL = undefined

        /* Perform API call for Top references (formerly Incoming suggestions) */
        // OA & S2: If all references are supposed to be retrieved get multiple references at once based on inputArticlesIds (faster)
        // Otherwise use ids derived from references
        const retrieveAllReferencesOAS2 = retrieveReferences === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API)
        let incomingSuggestionsIds
        if (!retrieveAllReferencesOAS2) {
          incomingSuggestionsIds = Object.keys(referenced)
            .filter(x => !inputArticlesIds.includes(x))
            .sort((a, b) => referenced[b].length - referenced[a].length).slice(0, retrieveReferences)
        }
        this.callAPI(retrieveAllReferencesOAS2 ? inputArticlesIdsWithoutSource : incomingSuggestionsIds, data => {
          let incomingSuggestions = this.responseToArray(data, API)

          if (retrieveAllReferencesOAS2) {
            // Update referenced & citing
            populateReferencedCiting(incomingSuggestions)

            // De-duplicate vs inputArticles
            incomingSuggestions = incomingSuggestions.filter(article => !inputArticlesIds.includes(article.id))
            incomingSuggestionsIds = incomingSuggestions.map(x => x.id)
          }
          this.$set(newGraph, 'referenced', reduceObject(referenced, inputArticlesIds.concat(incomingSuggestionsIds)))
          this.$set(newGraph, 'citing', reduceObject(citing, inputArticlesIds.concat(incomingSuggestionsIds)))

          // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
          this.$set(newGraph, 'incomingSuggestions', incomingSuggestions)

          if (this.currentGraph !== newGraph) {
            this.currentGraph = this.currentGraph[this.currentGraph.indexOf(newGraph)]
          }
          // Must be after init because of sorting
          this.init()
          this.saveState()

          /* Perform API call for Top citations (formerly Outgoing suggestions) */
          // Only works with OpenAlex, Semantic Scholar and OpenCitations
          // OA & S2: If all citations are supposed to be retrieved get multiple citations at once based on inputArticlesIds (faster)
          // Otherwise use ids derived from citations
          if (this.retrieveCitations && ['OpenAlex', 'Semantic Scholar', 'OpenCitations'].includes(API)) {
            const retrieveAllCitationsOAS2 = retrieveCitations === Infinity && ['OpenAlex', 'Semantic Scholar'].includes(API)
            let outgoingSuggestionsIds
            if (!retrieveAllCitationsOAS2) {
              outgoingSuggestionsIds = Object.keys(citing)
                .filter(x => !inputArticlesIds.includes(x) && !incomingSuggestionsIds.includes(x))
                .sort((a, b) => citing[b].length - citing[a].length).slice(0, retrieveCitations)
            }
            this.callAPI(retrieveAllCitationsOAS2 ? inputArticlesIds : outgoingSuggestionsIds, data => {
              let outgoingSuggestions = this.responseToArray(data, API)

              if (retrieveAllCitationsOAS2) {
                // Update referenced & citing (has to occur before de-duplication for citations because Semantic Scholar doesn't provide reference lists for citations endpoint)
                populateReferencedCiting(outgoingSuggestions)

                // De-duplicate vs inputArticles & incomingSuggestions
                outgoingSuggestions = outgoingSuggestions.filter(article => !(inputArticlesIds.concat(incomingSuggestionsIds)).includes(article.id))
                outgoingSuggestionsIds = outgoingSuggestions.map(x => x.id)
              }
              this.$set(newGraph, 'referenced', reduceObject(referenced, inputArticlesIds.concat(incomingSuggestionsIds).concat(outgoingSuggestionsIds)))
              this.$set(newGraph, 'citing', reduceObject(citing, inputArticlesIds.concat(incomingSuggestionsIds).concat(outgoingSuggestionsIds)))

              // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
              this.$set(newGraph, 'outgoingSuggestions', outgoingSuggestions)

              if (this.currentGraph !== newGraph) {
                this.currentGraph = this.currentGraph[this.currentGraph.indexOf(newGraph)]
              }
              // Must be after init because of sorting
              this.init()
              this.saveState()
            }, API, 'citations', false, retrieveCitations === Infinity)
          }
        }, API, 'references', retrieveReferences === Infinity, false)
      }, API, 'input', retrieveReferences === Infinity, retrieveCitations === Infinity)
    },
    pushGraph: function (newGraph) {
      this.graphs.push(newGraph)

      // Don't keep more articles in tab-bar than maxTabs
      if (this.graphs.length > this.maxTabs) this.graphs = this.graphs.slice(1)

      // Let user explore input articles while suggestions are still loading
      this.showArticlesTab = 'inputArticles'
      this.currentTabIndex = this.graphs.length - 1
      vm.saveState()
    },
    clickOpenReferences: function (article) {
      const id = article.id
      const graphSourceIds = this.graphs.map(graph => graph.source.id)

      // If reference is already open in a different tab: change tabs only
      if (graphSourceIds.includes(id)) {
        this.currentTabIndex = graphSourceIds.indexOf(id)
      // Load new source through API when source used different API than currently active
      } else {
        this.newSource = String(article.doi)
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
          value: this.newSource,
          required: null
        },
        onConfirm: value => { this.newSource = value }
      })
    },
    clickCloseTab: function (index) {
      // Close tab
      this.graphs.splice(index, 1)
      // If a tab is closed before the selected one or the last tab is selected and closed: update currentTabIndex
      if (this.currentTabIndex > index || this.currentTabIndex > this.graphs.length - 1) {
        this.currentTabIndex--
        if (this.currentTabIndex === -1) this.currentTabIndex = undefined
      }
      this.saveState()
    },
    clickCloseAllTabs: function () {
      this.$buefy.dialog.confirm({
        message: 'Do you want to close all network tabs?',
        type: 'is-danger',
        confirmText: 'Close All',
        onConfirm: () => {
          this.currentTabIndex = undefined
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
      // Destroy old networks if already there
      this.resetBothNetworks()

      // Sort tables & select top article for tables
      this.currentGraph.input.sort(this.sortInDegree)
      this.selectedInputArticle = this.currentGraph.input[0]

      if (this.currentGraph.incomingSuggestions?.length) {
        this.currentGraph.incomingSuggestions.sort(this.sortInDegree)
        this.selectedIncomingSuggestionsArticle = this.currentGraph.incomingSuggestions[0]
      }
      if (this.currentGraph.outgoingSuggestions?.length) {
        this.currentGraph.outgoingSuggestions.sort(this.sortOutDegree)
        this.selectedOutgoingSuggestionsArticle = this.currentGraph.outgoingSuggestions[0]
      }

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
      return (this.currentGraph.referenced[id]?.length || 0)
    },
    outDegree: function (id) {
      return (this.currentGraph.citing[id]?.length || 0)
    },
    // compareFunction for array.sort(), in this case descending by default (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort)
    sortInDegree: function (articleA, articleB) {
      let a = this.inDegree(articleA.id)
      let b = this.inDegree(articleB.id)
      // In case of a tie sort by outDegree secondarily
      if (a === b) {
        a = this.outDegree(articleA.id)
        b = this.outDegree(articleB.id)
      }
      // In case of another tie sort by year thirdly
      if (a === b) {
        a = articleA.year || 0
        b = articleB.year || 0
      }
      return b - a
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
      return b - a
    },
    sortReferences: function (articleA, articleB) {
      let a = articleA.referencesCount ?? articleA.references.length
      let b = articleB.referencesCount ?? articleB.references.length
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
      return b - a
    },
    // Wrapper for Buefy tables with third argument "ascending"
    sortInDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortInDegree(b, a) : this.sortInDegree(a, b)
    },
    sortOutDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortOutDegree(b, a) : this.sortOutDegree(a, b)
    },
    sortReferencesWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortReferences(b, a) : this.sortReferences(a, b)
    },
    callAPI: function (ids, response, API, phase, retrieveAllReferences = false, retrieveAllCitations = false) {
      if (API === 'OpenAlex') {
        return openAlexWrapper(ids, response, phase, retrieveAllReferences, retrieveAllCitations)
      } else if (API === 'Semantic Scholar') {
        return semanticScholarWrapper(ids, response, phase, retrieveAllReferences, retrieveAllCitations)
      } else if (API === 'OpenCitations') {
        return openCitationsWrapper(ids, response, phase)
      } else if (API === 'Crossref') {
        return crossrefWrapper(ids, response, phase)
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
      // Remove duplicates (e.g. for S2 in references of 10.1111/J.1461-0248.2009.01285.X, eebf363bc78ca7bc16a32fa339004d0ad43aa618 came up twice)
      articles = articles.reduce((data, article) => {
        const ids = data.map(x => x.id)
        if (!ids.includes(article.id)) data.push(article)
        return data
      }, [])
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
            // Delete these two possibly existing flags so that only "Top references" / "Top citations" instead of "All references" / "All citations" will be shown
            if (graph.incomingSuggestions === undefined || graph.incomingSuggestions.length > maxReferencesCitations) delete graph.allReferences
            if (graph.outgoingSuggestions === undefined || graph.outgoingSuggestions.length > maxReferencesCitations) delete graph.allCitations
            // Don't save suggestions still in loading phase
            // Otherwise suggestions would be saved in loading state (undefined) but after reload they do not continue to load!
            if (graph.incomingSuggestions === undefined) graph.incomingSuggestions = []
            // Only save up to 100 incomingSuggestions (References) & outgoingSuggestions (Citations) for space constraints
            else graph.incomingSuggestions = graph.incomingSuggestions.slice(0, maxReferencesCitations)
            if (graph.outgoingSuggestions === undefined) graph.outgoingSuggestions = []
            else graph.outgoingSuggestions = graph.outgoingSuggestions.slice(0, maxReferencesCitations)

            return graph
          }))
        }
        if (saveSettings) {
          localStorage.autosaveResults = true
          localStorage.API = this.API
          localStorage.retrieveReferences = this.retrieveReferences
          localStorage.retrieveCitations = this.retrieveCitations
        }
      } else {
        localStorage.clear()
      }
    },
    filterArticles: function (articles) {
      const re = new RegExp(this.filterString, 'gi')
      switch (this.filterColumn) {
        case 'titleAbstract':
          return articles.filter(article => String(article.numberInSourceReferences).match(new RegExp(this.filterString, 'y')) ||
          (article.id?.match(re)) ||
          (article.doi?.match(re)) ||
          (article.title?.match(re)) ||
          (article.abstract?.match(re)))
        case 'authors':
          return articles.filter(article => this.authorString(article.authors).match(re) || article.authors.map(author => author.affil?.match(re)).some(Boolean))
        case 'year':
          return articles.filter(article => String(article.year).match(re))
        case 'journal':
          return articles.filter(article => String(article.journal).match(re))
        default:
          return articles
      }
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
    addGraphsFromJSON: function (graphs) {
      const graphTabLabels = this.graphs.map(x => x.tabLabel)
      for (const graph of graphs) {
        if (!graphTabLabels.includes(graph.tabLabel)) this.pushGraph(graph)
        else this.errorMessage("Tab with name '" + graph.tabLabel + "' already exists!")
      }
    },
    loadGraphsFromJSON: function (path) {
      this.isLoading = true
      // If path is neither "examples.json" nor a URL, check hardcoded path for "cache"
      if (path !== 'examples.json' && !(path.startsWith('https://') || path.startsWith('http://'))) {
        path = 'https://raw.githubusercontent.com/LocalCitationNetwork/cache/main/' + path
      }
      fetch(path).then(data => data.json()).then(graphs => {
        this.addGraphsFromJSON(graphs)
        this.isLoading = false
      }).catch(e => {
        this.isLoading = false
        this.errorMessage('Could not load cached networks from ' + path + ': ' + e)
      })
    },
    toggleArticle: function () {
      this.$refs[this.showArticlesTab + 'Table'].toggleDetails(this.selected)
    },
    tableArrowUpChangePage: function () {
      if (this[this.showArticlesTab + 'TablePage'] > 1 && (this.$refs[this.showArticlesTab + 'Table'].newData.indexOf(this.selected) + 1) % 10 === 1) {
        return this[this.showArticlesTab + 'TablePage'] -= 1
      }
    },
    tableArrowDownChangePage: function () {
      const maxPage = Math.ceil(this.$refs[this.showArticlesTab + 'Table'].newData.length / 10)
      if (this[this.showArticlesTab + 'TablePage'] < maxPage && (this.$refs[this.showArticlesTab + 'Table'].newData.indexOf(this.selected) + 1) % 10 === 0) {
        return this[this.showArticlesTab + 'TablePage'] += 1
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
      if (this.newSource) {
        this.setNewSource(this.newSource, this.listOfIds)
      } else {
        this.createNewNetwork({ references: this.listOfIds, citations: [] })
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
      else if (this.currentGraph.API === 'OpenAlex' && article.id) return 'https://openalex.org/' + article.id // ?.match(new RegExp('W\d+'))
      else if (this.currentGraph.API === 'Semantic Scholar' && article.id) return 'https://semanticscholar.org/paper/' + article.id
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
      this.saveState()
    },
    downloadCSVData: function (table) {
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
      csv += table.map(row => {
        let arr = [row.id, row.doi, (this.showArticlesTab === 'inputArticles' && this.showNumberInSourceReferences) ? row.numberInSourceReferences : false, row.type, row.title, this.authorString(row.authors), row.journal, row.year, row.date, row.volume, row.issue, row.firstPage, row.lastPage, row.abstract, row.citationsCount, this.inDegree(row.id), this.outDegree(row.id), row.references.length, this.currentGraph.referenced[row.id], this.currentGraph.citing[row.id], row.references]
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
    downloadRISData: function (table) {
      // TODO: consider mapping types to RIS types instead of always using "TY  - JOUR" (journal article)
      // OpenAlex types: https://api.openalex.org/works?group_by=type
      // RIS Types: https://en.wikipedia.org/wiki/RIS_(file_format)#Type_of_reference
      let ris = ''
      table.forEach(row => {
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
  created: function () {
    const urlParams = new URLSearchParams(window.location.search)

    // Load locally saved networks / settings from localStorage
    try {
      if (localStorage.graphs) this.graphs = JSON.parse(localStorage.graphs)
      if (localStorage.autosaveResults) this.autosaveResults = localStorage.autosaveResults === 'true'
      if (localStorage.API && ['OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref'].includes(localStorage.API)) this.API = localStorage.API
      if (!isNaN(Number(localStorage.retrieveReferences))) this.retrieveReferences = Number(localStorage.retrieveReferences)
      if (!isNaN(Number(localStorage.retrieveCitations))) this.retrieveCitations = Number(localStorage.retrieveCitations)
    } catch (e) {
      localStorage.clear()
      console.log("Couldn't load locally saved networks / settings.")
    }

    // Set API according to link
    if (urlParams.has('API') && ['OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref'].includes(urlParams.get('API'))) {
      this.API = urlParams.get('API')
    }

    // Open listOfIds from link / bookmarklet
    if (urlParams.has('listOfIds')) {
      // Safety measure to allow max. 500 Ids
      const DOIs = urlParams.get('listOfIds').split(',')
        .slice(0, 500)
        .map(id => (id.match(/10\.\d{4,9}\/\S+/)) ? id.match(/10\.\d{4,9}\/\S+/)[0].toUpperCase() : id)

      this.listOfIds = DOIs
      this.listName = urlParams.has('name') ? urlParams.get('name') : 'Custom'
      this.bookmarkletURL = urlParams.has('bookmarkletURL') ? urlParams.get('bookmarkletURL') : undefined
      this.editListOfIds = true
    }

    // Open source from link
    if (urlParams.has('source')) {
      const id = urlParams.get('source')
      const graphSourceIds = this.graphs.map(graph => graph.source.id)
      const graphSourceDOIs = this.graphs.map(graph => graph.source.doi)

      // Only if reference is not already open in a different tab with same API (setting to correct tab via this.currentTabIndex = X doesn't work because it is initialized to default afterwards)
      if (
        !(graphSourceIds.includes(id) && this.graphs[graphSourceIds.indexOf(id)].API === this.API) &&
        !(graphSourceDOIs.includes(id.toUpperCase()) && this.graphs[graphSourceDOIs.indexOf(id.toUpperCase())].API === this.API)
      ) {
        this.newSource = id
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

    if (this.graphs.length) {
      this.currentTabIndex = 0
    }

    // Hack: showCitationNetworkSettings and showAuthorNetworkSettings have to be true initially for modal containers to be created and available for vis.js network
    // They have visibility: hidden initially
    // Make network settings visible (they briefly flash up after loading the page so that the DOM elements are created for vis.js)
    setTimeout(function () {
      vm.showCitationNetworkSettings = false
      vm.showAuthorNetworkSettings = false
    }, 1)
    setTimeout(function () {
      document.getElementById('citationNetworkSettingsModal').style.visibility = 'visible'
      document.getElementById('authorNetworkSettingsModal').style.visibility = 'visible'
    }, 3000)
  }
})
