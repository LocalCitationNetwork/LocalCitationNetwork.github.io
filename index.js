/* Local Citation Network v1.11 (GPL-3) */
/* by Tim Woelfle */
/* https://timwoelfle.github.io/Local-Citation-Network */

/* global fetch, localStorage, vis, Vue, Buefy */

'use strict'

const localCitationNetworkVersion = 1.11

const arrSum = arr => arr.reduce((a, b) => a + b, 0)
const arrAvg = arr => arrSum(arr) / arr.length

/* Semantic Scholar API */
// https://api.semanticscholar.org/api-docs/graph#tag/paper

async function semanticScholarWrapper (ids, responseFunction, isLoadingProgress = false, getCitations = false, getReferenceContexts = false) {
  const responses = []
  if (isLoadingProgress) vm.isLoadingTotal = ids.length
  for (const i of Array(ids.length).keys()) {
    let response
    if (isLoadingProgress) vm.isLoadingIndex = i
    if (ids[i]) {
      response = await semanticScholarPaper(ids[i], getCitations, false)
      if (getReferenceContexts) {
        const referenceContexts = await semanticScholarPaper(ids[i], false, true)
        if (referenceContexts) { response.referenceContexts = referenceContexts }
      }
    }
    responses.push(response)
  }
  responseFunction(responses)
  if (isLoadingProgress) vm.isLoadingTotal = 0
}

function semanticScholarPaper (id, getCitations, getReferenceContexts) {
  let fields = 'externalIds,title,abstract,journal,venue,year,citationCount,authors.externalIds,authors.name,authors.affiliations,references.paperId'
  if (getCitations) fields += ',citations.paperId'
  if (getReferenceContexts) fields = 'paperId,contexts&limit=1000'
  return fetch('https://api.semanticscholar.org/graph/v1/paper/' + id + (getReferenceContexts ? '/references' : '') + '?fields=' + fields).then(response => {
    if (!response.ok) throw (response)
    return response.json()
  }).catch(async function (response) {
    // "Too Many Requests" errors (status 429) are unfortunately sent with wrong CORS header and thus cannot be distinguished from generic network errors
    if (response.status === 429 || typeof response.statusText !== 'string') {
      if (response.status === 429) vm.errorMessage('Semantic Scholar (S2) reports too rapid requests. Waiting 2 minutes...')
      else vm.errorMessage('Semantic Scholar (S2) not reachable, probably too rapid requests. Waiting 2 minutes...')
      await new Promise(resolve => setTimeout(resolve, 120000))
      return semanticScholarPaper(id, getCitations)
    }
    vm.errorMessage('Error while processing data through Semantic Scholar API for ' + id + ': ' + response.statusText + ' (' + response.status + ')')
    return false
  })
}

function semanticScholarResponseToArticleArray (data) {
  return data.filter(Boolean).map(article => {
    const doi = article.externalIds && article.externalIds.DOI && article.externalIds.DOI.toUpperCase()

    return {
      id: article.paperId,
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      title: article.title || '',
      authors: (article.authors || []).map(author => {
        const cutPoint = (author.name.lastIndexOf(',') !== -1) ? author.name.lastIndexOf(',') : author.name.lastIndexOf(' ')
        return {
          id: author.authorId,
          orcid: author.externalIds && author.externalIds.ORCID,
          url: author.url,
          LN: author.name.substr(cutPoint + 1),
          FN: author.name.substr(0, cutPoint),
          affil: (author.affiliations || []).join(', ') || undefined
        }
      }),
      year: article.year,
      journal: (article.journal && article.journal.name) || article.venue,
      references: (article.references) ? article.references.map(x => x.paperId) : [],
      citations: (article.citations) ? article.citations.map(x => x.paperId).filter(Boolean) : [],
      citationsCount: article.citationCount,
      abstract: article.abstract,
      referenceContexts: article.referenceContexts && Object.fromEntries(article.referenceContexts.data.filter(x => x.citedPaper.paperId).map(x => [x.citedPaper.paperId, x.contexts]))
    }
  })
}

/* OpenAlex API */
// https://docs.openalex.org/about-the-data/work#the-work-object

async function openAlexWrapper (ids, responseFunction, isLoadingProgress = false, getCitations = false) {
  const responses = []
  ids = ids.map(id => {
    if (!id) return undefined
    else if (id.includes('https://')) return id
    else if (id.toLowerCase().match(/openalex:|doi:|mag:|pmid:|pmcid:/)) return id.toLowerCase()
    else if (id.includes('/')) return 'doi:' + id
    else return 'openalex:' + id
  })
  if (isLoadingProgress) vm.isLoadingTotal = ids.length
  for (const i of Array(ids.length).keys()) {
    let response
    if (isLoadingProgress) vm.isLoadingIndex = i
    if (ids[i]) {
      response = await openAlexWorks('/' + ids[i].replace('openalex:', '') + '?select=id,doi,display_name,authorships,publication_year,primary_location,referenced_works,cited_by_count,abstract_inverted_index,is_retracted')
      if (getCitations && response.id) {
        // TODO These results are incomplete when a paper is cited by >200 (current per-page upper-limit of OA)
        const citations = await openAlexWorks('?select=id&per-page=200&sort=cited_by_count:desc&filter=cites:' + response.id.replace('https://openalex.org/', ''))
        if (citations) { response.citations = citations }
      }
    }
    responses.push(response)
  }
  responseFunction(responses)
  if (isLoadingProgress) vm.isLoadingTotal = 0
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
      id: article.id.replace('https://openalex.org/', ''),
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      title: article.display_name || '',
      authors: (article.authorships || []).map(authorship => {
        const display_name = authorship.author.display_name || ''
        const cutPoint = (display_name.lastIndexOf(',') !== -1) ? display_name.lastIndexOf(',') : display_name.lastIndexOf(' ')
        return {
          id: authorship.author.id && authorship.author.id.replace('https://openalex.org/', ''),
          orcid: authorship.author.orcid && authorship.author.orcid.replace('https://orcid.org/', ''),
          LN: display_name.substr(cutPoint + 1),
          FN: display_name.substr(0, cutPoint),
          affil: (authorship.institutions || []).map(institution => institution.display_name + (institution.country_code ? ' (' + institution.country_code + ')' : '')).join(', ') || undefined
        }
      }),
      year: article.publication_year,
      journal: (article.primary_location && article.primary_location.source && (
        article.primary_location.source.display_name +
        ((article.primary_location.source.host_organization_name && !article.primary_location.source.display_name.includes(article.primary_location.source.host_organization_name)) ? ' (' + article.primary_location.source.host_organization_name + ')' : '')
      )) ?? undefined,
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

async function crossrefWrapper (ids, responseFunction, isLoadingProgress = false) {
  const responses = []
  if (isLoadingProgress) vm.isLoadingTotal = ids.length
  for (const i of Array(ids.length).keys()) {
    let response
    if (isLoadingProgress) vm.isLoadingIndex = i
    if (ids[i]) response = await crossrefWorks(ids[i])
    responses.push(response)
  }
  responseFunction(responses)
  if (isLoadingProgress) vm.isLoadingTotal = 0
}

function crossrefWorks (id) {
  // TODO Now that subselection of results is fixed, it could be leveraged to reduce API load (https://gitlab.com/crossref/issues/issues/511)
  return fetch('https://api.crossref.org/works/' + id + '?mailto=local-citation-network@timwoelfle.de').then(response => {
    if (!response.ok) throw (response)
    return response.json()
  }).then(data => {
    if (typeof data !== 'object' || !data.message) throw ({ statusText: 'Empty response.' })
    return (data.message)
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
    const doi = article.DOI && article.DOI.toUpperCase()

    return {
      id: doi,
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      title: String(article.title), // most of the time title is an array with length=1, but I've also seen pure strings
      authors: (article.author && article.author.length) ? article.author.map(x => ({
        orcid: x.ORCID,
        LN: x.family || x.name,
        FN: x.given,
        affil: (x.affiliation && x.affiliation.length) ? x.affiliation.map(aff => aff.name).join(', ') : (typeof (x.affiliation) === 'string' ? x.affiliation : undefined)
      })) : [{ LN: article.author || undefined }],
      year: article.issued['date-parts'] && article.issued['date-parts'][0] && article.issued['date-parts'][0][0],
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

async function openCitationsWrapper (ids, responseFunction, isLoadingProgress = false) {
  const responses = []
  if (isLoadingProgress) vm.isLoadingTotal = ids.length
  for (const i of Array(ids.length).keys()) {
    let response
    if (isLoadingProgress) vm.isLoadingIndex = i
    if (ids[i]) response = (await openCitationsMetadata(ids[i]))[0]
    responses.push(response)
  }
  responseFunction(responses)
  if (isLoadingProgress) vm.isLoadingTotal = 0
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
    const doi = article.doi && article.doi.toUpperCase()

    return {
      id: doi,
      numberInSourceReferences: data.indexOf(article) + 1,
      doi: doi,
      title: String(article.title), // most of the time title is an array with length=1, but I've also seen pure strings
      authors: article.author.split('; ').map(x => ({ LN: x.split(', ')[0], FN: x.split(', ')[1] })),
      year: article.year,
      journal: String(article.source_title),
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

function initCitationNetwork (app) {
  // This line is necessary because of v-if="currentTabIndex !== undefined" in the main columns div, which apparently is evaluated after watch:currentTabIndex is called
  if (!document.getElementById('citationNetwork')) {
    return setTimeout(function () { app.init(); app.highlightNodes() }, 1)
  }

  // Prevent multiple configurators to be added one after another
  document.getElementById('citationNetworkConfigure').innerHTML = ''

  // Create an array with nodes
  let articles = app.currentGraph.input.filter(article => (app.settings.citationNetworkShowSource ? true : !article.isSource)).concat(app.incomingSuggestionsSliced).concat(app.outgoingSuggestionsSliced)
  articles = articles.filter(article => article.year)

  // Create an array with edges
  const articlesIds = articles.map(article => article.id)
  const keepArticlesIds = new Set()
  const edges = articles.map(function (article) {
    return (!article.references) ? [] : article.references.map(function (ref) {
      if (articlesIds.includes(ref)) {
        keepArticlesIds.add(article.id)
        keepArticlesIds.add(ref)
        return { from: article.id, to: ref }
      } else {
        return []
      }
    })
  }).flat(2)

  // Only keep connected articles (no singletons)
  articles = articles.filter(article => keepArticlesIds.has(article.id))

  // Sort by rank of year
  const years = Array.from(new Set(articles.map(article => article.year).sort()))

  const nodes = articles.map(article => ({
    id: article.id,
    title: htmlTitle(app.authorStringShort(article.authors) + '. <a><em>' + article.title + '</em></a>. ' + article.journal + '. ' + article.year + '.<br>(Double click opens article: <a>' + app.articleLink(article).substr(0, 28) + '...</a>)'),
    level: years.indexOf(article.year),
    group: article[app.settings.citationNetworkNodeColor],
    value: arrSum([['in', 'both'].includes(app.settings.citationNetworkNodeSize) ? app.inDegree(article.id) : 0, ['out', 'both'].includes(app.settings.citationNetworkNodeSize) ? app.outDegree(article.id) : 0]),
    shape: (app.currentGraph.source.id === article.id) ? 'diamond' : (app.inputArticlesIds.includes(article.id) ? 'dot' : (app.incomingSuggestionsIds.includes(article.id) ? 'triangle' : 'triangleDown')),
    label: (article.authors[0] && article.authors[0].LN) + '\n' + article.year
  }))

  // Create network
  const options = {
    layout: {
      hierarchical: {
        direction: app.fullscreenNetwork ? 'LR' : 'DU',
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
      width: 8
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
  citationNetwork.on('resize', function () {
    citationNetwork.setOptions({ physics: true, layout: { hierarchical: { direction: app.fullscreenNetwork ? 'LR' : 'DU' } } })
    citationNetwork.stabilize(100)
  })

  citationNetwork.on('stabilizationIterationsDone', function (params) {
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
        app.selectedInputArticle = app.currentGraph.input[app.inputArticlesIds.indexOf(selectedNodeId)]
        // Suggested article node was clicked (triangle)
      } else if (app.incomingSuggestionsIds.includes(selectedNodeId)) {
        app.showArticlesTab = 'incomingSuggestions'
        app.selectedIncomingSuggestionsArticle = app.currentGraph.incomingSuggestions[app.incomingSuggestionsIds.indexOf(selectedNodeId)]
      } else {
        app.showArticlesTab = 'outgoingSuggestions'
        app.selectedOutgoingSuggestionsArticle = app.currentGraph.outgoingSuggestions[app.outgoingSuggestionsIds.indexOf(selectedNodeId)]
      }
      if (document.getElementById(selectedNodeId)) document.getElementById(selectedNodeId).scrollIntoView({ behavior: 'smooth', block: 'center' })
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

  // Prevent multiple configurators to be added one after another
  document.getElementById('authorNetworkConfigure').innerHTML = ''

  let allAuthors = app.currentGraph.input.concat(app.incomingSuggestionsSliced).concat(app.outgoingSuggestionsSliced).map(article => article.authors.map(x => { x.name = app.authorString([x]); x.id = x.name; return x })) // TODO: used to be "x.id = x.id || x.name" but caused too many duplicates (at least on OA), double check in the future if this has been fixed
  let authorIdGroups = allAuthors.map(authorGroup => authorGroup.map(author => author.id))
  allAuthors = Object.fromEntries(allAuthors.flat().map(author => [author.id, author]))

  // Count publications per author
  const publicationsCount = {}
  authorIdGroups.flat().forEach(authorId => { publicationsCount[authorId] = (publicationsCount[authorId] || 0) + 1 })

  let authorIdsWithMinPubs = []
  const links = {}

  if (!minPublications) {
    minPublications = 2
    authorIdsWithMinPubs = Object.keys(publicationsCount).filter(authorId => publicationsCount[authorId] >= minPublications)
    while (authorIdsWithMinPubs.length > 50) {
      minPublications++
      authorIdsWithMinPubs = Object.keys(publicationsCount).filter(authorId => publicationsCount[authorId] >= minPublications)
    }
    app.minPublications = minPublications
  } else {
    authorIdsWithMinPubs = Object.keys(publicationsCount).filter(authorId => publicationsCount[authorId] >= minPublications)
  }

  authorIdGroups = authorIdGroups.map(group => group.filter(authorId => authorIdsWithMinPubs.includes(authorId)))

  authorIdGroups.forEach(group => group.forEach(authorId1 => group.forEach(authorId2 => {
    if (authorId1 === authorId2) return false

    // Is there already a link for this pair? If so, make it stronger
    if (links[authorId1] && links[authorId1][authorId2]) return links[authorId1][authorId2]++
    if (links[authorId2] && links[authorId2][authorId1]) return links[authorId2][authorId1]++

    // Create new link
    if (!links[authorId1]) links[authorId1] = {}
    links[authorId1][authorId2] = 1
  })))

  const edges = Object.keys(links).map(authorId1 => Object.keys(links[authorId1]).map(authorId2 => {
    return { from: authorId1, to: authorId2, value: links[authorId1][authorId2], title: allAuthors[authorId1].name + ' & ' + allAuthors[authorId2].name + ' (' + links[authorId1][authorId2] / 2 + ' collaboration(s) among source, input & suggested articles)' }
  })).flat(2)

  const nodes = authorIdsWithMinPubs.map(authorId => {
    const author = allAuthors[authorId]
    const isSourceAuthor = app.authorString(app.currentGraph.source.authors).includes(author.name)
    const inputArticlesAuthoredCount = app.currentGraph.input.filter(article => app.authorString(article.authors).includes(author.name)).length
    const incomingSuggestionsAuthoredCount = app.incomingSuggestionsSliced.filter(article => app.authorString(article.authors).includes(author.name)).length
    const outgoingSuggestionsAuthoredCount = app.outgoingSuggestionsSliced.filter(article => app.authorString(article.authors).includes(author.name)).length
    return {
      id: author.id,
      title: htmlTitle(author.name + (author.affil ? ', ' + author.affil : '') + ': author of ' + (isSourceAuthor ? 'source article, ' : '') + inputArticlesAuthoredCount + ' input articles & ' + (incomingSuggestionsAuthoredCount + outgoingSuggestionsAuthoredCount) + ' suggested articles.<br>(Double click opens author: <a>' + app.authorLink(author).substr(0, 28) + '...</a>)'),
      group: authorIdGroups.map(group => group.includes(author.id)).indexOf(true),
      label: author.LN + ((app.settings.authorNetworkFirstNames) ? (', ' + author.FN) : ''),
      value: publicationsCount[author.id],
      mass: publicationsCount[author.id],
      shape: (isSourceAuthor) ? 'diamond' : (inputArticlesAuthoredCount ? 'dot' : (incomingSuggestionsAuthoredCount ? 'triangle' : 'triangleDown'))
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
  authorNetwork.on('resize', function () {
    authorNetwork.setOptions({ physics: true })
    authorNetwork.stabilize(100)
  })

  authorNetwork.on('stabilizationIterationsDone', function (params) {
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
    maxTabs: 5,
    autosaveResults: false,
    settings: {
      getCitationsOA: false, // experimental
      citationNetworkNodeColor: 'year', // Other options: 'journal'
      citationNetworkNodeSize: 'both', // Other options: 'in', 'out'
      citationNetworkShowSource: true,
      authorNetworkFirstNames: false
    },

    // Data
    graphs: [],
    newSource: undefined,
    file: undefined,
    listOfIds: undefined,
    listName: undefined,
    bookmarkletURL: undefined,

    // UI
    fullscreenNetwork: false,
    filterColumn: 'titleAbstract',
    filterString: undefined,
    selectedInputArticle: undefined,
    selectedIncomingSuggestionsArticle: undefined,
    selectedOutgoingSuggestionsArticle: undefined,
    currentTabIndex: undefined,
    showArticlesTab: 'inputArticles',
    showAuthorNetwork: 0,
    minPublications: 2,
    isLoading: false,
    isLoadingIndex: 0,
    isLoadingTotal: 0,
    showFAQ: false,
    indexFAQ: 'about',
    editListOfIds: false,
    showCitationNetworkSettings: true,
    showAuthorNetworkSettings: true
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
    incomingSuggestionsSliced: function () {
      return (this.currentGraph.incomingSuggestions || []).slice(0, this.currentGraph.maxIncomingSuggestions ?? 10)
    },
    outgoingSuggestionsSliced: function () {
      return (this.currentGraph.outgoingSuggestions || []).slice(0, this.currentGraph.maxOutgoingSuggestions ?? 10)
    },
    inputArticlesIds: function () {
      return this.currentGraph.input.map(article => article.id)
    },
    incomingSuggestionsIds: function () {
      return this.incomingSuggestionsSliced.map(article => article.id)
    },
    outgoingSuggestionsIds: function () {
      return this.outgoingSuggestionsSliced.map(article => article.id)
    },
    inputArticlesFiltered: function () {
      return this.filterArticles(this.currentGraph.input)
    },
    incomingSuggestionsFiltered: function () {
      return this.filterArticles(this.incomingSuggestionsSliced)
    },
    outgoingSuggestionsFiltered: function () {
      return this.filterArticles(this.outgoingSuggestionsSliced)
    },
    selected: {
      get: function () {
        switch (this.showArticlesTab) {
          case 'inputArticles': return this.selectedInputArticle
          case 'incomingSuggestions': return this.selectedIncomingSuggestionsArticle
          case 'outgoingSuggestions': return this.selectedOutgoingSuggestionsArticle
        }
      },
      set: function (x) {
        switch (this.showArticlesTab) {
          case 'inputArticles': this.selectedInputArticle = x
          case 'incomingSuggestions': this.selectedIncomingSuggestionsArticle = x
          case 'outgoingSuggestions': this.selectedOutgoingSuggestionsArticle = x
        }
      }
    },
    linkToShareAppendix: function () {
      let appendix = '?API=' + encodeURIComponent(this.currentGraph.API)
      if (this.currentGraph.source.id) {
        appendix += '&source=' + (this.currentGraph.source.doi ? this.currentGraph.source.doi : this.currentGraph.source.id)
        if (this.currentGraph.source.customListOfReferences) {
          appendix += '&listOfIds=' + this.currentGraph.source.customListOfReferences.join(',')
        }
      } else {
        appendix += '&name=' + encodeURIComponent(this.currentGraph.tabLabel) + '&listOfIds=' + this.currentGraph.source.references.join(',')
      }
      return appendix
    },
    showNumberInSourceReferences: function () {
      return this.currentGraph.API === 'Crossref' || (this.currentGraph.source.customListOfReferences !== undefined) || !this.currentGraph.source.id
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
    maxIncomingSuggestions: function () {
      // Prevent too many re-inits
      if (this.graphs.length && document.getElementById('citationNetwork')) {
        initCitationNetwork(this)
        initAuthorNetwork(this)
        this.highlightNodes()
      }
    },
    maxOutgoingSuggestions: function () {
      // Prevent too many re-inits
      if (this.graphs.length && document.getElementById('citationNetwork')) {
        initCitationNetwork(this)
        initAuthorNetwork(this)
        this.highlightNodes()
      }
    },
    showAuthorNetwork: function () {
      this.highlightNodes()
      // Avoid resizing (and thus flickering) of networks when changing tabs
      if (this.showAuthorNetwork) {
        citationNetwork.setOptions({ autoResize: false })
        setTimeout(function () { authorNetwork.setOptions({ autoResize: true }) }, 1)
      } else {
        authorNetwork.setOptions({ autoResize: false })
        setTimeout(function () { citationNetwork.setOptions({ autoResize: true }) }, 1)
      }
    },
    minPublications: function () {
      if (this.showAuthorNetwork) {
        initAuthorNetwork(this, this.minPublications)
        this.highlightNodes()
      }
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
      }, API, false, true, true) // isLoadingProgress=false, getCitations=true, referenceContexts=true
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
      this.callAPI(source.references, data => {
        source.isSource = true
        let referencedBy = {}
        let citing = {}
        let inputArticles = this.responseToArray(data, API)

        // If source has customListOfReferences its references must be updated to match id format of API (otherwise inDegree and outDegree and network don't work correctly)
        // Original list will be kept in source.customListOfReferences
        if (source.customListOfReferences) {
          source.references = inputArticles.map(article => article.id)
        }

        // Don't put source in inputArticles when a list without source was loaded
        if (source.id) inputArticles = inputArticles.concat(source)
        const inputArticlesIds = inputArticles.map(article => article.id)

        // Populate referencedBy and citing objects
        function addToCiting (outId, inId) {
          if (inputArticlesIds.includes(inId)) {
            if (!citing[outId]) citing[outId] = []
            if (!citing[outId].includes(inId)) citing[outId].push(inId)
          }
        }

        inputArticles.forEach(article => {
          article.references.filter(Boolean).forEach(refId => {
            if (!referencedBy[refId]) referencedBy[refId] = []
            // Avoid duplicate counting of references for in-degree (e.g. https://api.crossref.org/works/10.7717/PEERJ.3544 has 5 references to DOI 10.1080/00031305.2016.1154108)
            if (!referencedBy[refId].includes(article.id)) referencedBy[refId].push(article.id)

            addToCiting(article.id, refId)
          })
          if (['OpenAlex', 'Semantic Scholar', 'OpenCitations'].includes(API)) {
            article.citations.filter(Boolean).forEach(citId => {
              addToCiting(citId, article.id)
            })
            // Remove citations property to save space (otherwise localStorage quota exceeds sooner) because the information is now stored in "citing" variable
            delete inputArticles[inputArticles.indexOf(article)].citations
          }
        })

        // Find incoming suggestions (high in-degree = top outgoing references of input articles)
        // sort articles by number of local citations (inDegree) and pick top ones
        const incomingSuggestionsIds = Object.keys(referencedBy)
        // Only suggest articles that have at least two local citations and that aren't already among input articles
        // Careful with comparing DOIs!!! They have to be all same case (upper case in this app)
          .filter(x => referencedBy[x].length > 1 && !inputArticlesIds.includes(x))
          .sort((a, b) => referencedBy[b].length - referencedBy[a].length).slice(0, 20)

        let ids = inputArticlesIds.concat(incomingSuggestionsIds)

        // Find outgoing suggestions ids (high out-degree = top incoming citations of input articles)
        // Only works with Semantic Scholar and OpenCitations for now
        let outgoingSuggestionsIds = []
        if (['OpenAlex', 'Semantic Scholar', 'OpenCitations'].includes(API)) {
          outgoingSuggestionsIds = Object.keys(citing)
            // If - in theoretical cases, I haven't seen one yet - a top incoming citation is already a top reference, don't include it here again
            .filter(x => citing[x].length > 1 && !inputArticlesIds.includes(x) && !incomingSuggestionsIds.includes(x))
            .sort((a, b) => citing[b].length - citing[a].length).slice(0, 20)

          ids = ids.concat(outgoingSuggestionsIds)
        }

        // Reduce size of referenced and citing objects by only keeping entries for input articles and suggestions
        referencedBy = ids.reduce((newObject, id) => { newObject[id] = referencedBy[id]; return newObject }, {})
        citing = ids.reduce((newObject, id) => { newObject[id] = citing[id]; return newObject }, {})

        // Add new tab
        const newGraph = {
          source: source,
          input: inputArticles,
          incomingSuggestions: incomingSuggestionsIds.length ? undefined : [],
          outgoingSuggestions: outgoingSuggestionsIds.length ? undefined : [],
          referenced: referencedBy,
          citing: citing,
          tabLabel: source.id ? ((source.authors[0] && source.authors[0].LN) + ' ' + source.year) : this.listName,
          tabTitle: source.id ? source.title : this.listName,
          bookmarkletURL: this.bookmarkletURL,
          API: API,
          timestamp: Date.now(),
          localCitationNetworkVersion: localCitationNetworkVersion
        }
        this.pushGraph(newGraph)
        this.isLoading = false
        this.listName = undefined
        this.bookmarkletURL = undefined

        // Perform API call for incomingSuggestionsIds
        if (incomingSuggestionsIds.length) {
          this.callAPI(incomingSuggestionsIds, data => {
            const incomingSuggestions = this.responseToArray(data, API)
            // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
            this.$set(newGraph, 'incomingSuggestions', incomingSuggestions)

            // Crossref does not have incoming citation data, thus this has to be completed so that incoming suggestions have correct out-degrees, which are based on 'citing'
            if (['Crossref'].includes(API)) {
              incomingSuggestions.forEach(article => {
                article.references.filter(Boolean).forEach(refId => {
                  addToCiting(article.id, refId)
                })
              })
              this.$set(newGraph, 'citing', citing)
            }

            if (this.currentGraph === newGraph) {
              this.init()
              this.highlightNodes()
            }
            this.saveState()
          }, API)
        }

        // Perform API call for outgoingSuggestionsIds
        if (outgoingSuggestionsIds.length) {
          this.callAPI(outgoingSuggestionsIds, data => {
            // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
            this.$set(newGraph, 'outgoingSuggestions', this.responseToArray(data, API))
            if (this.currentGraph === newGraph) {
              this.init()
              this.highlightNodes()
            }
            this.saveState()
          }, API)
        }
      }, API, true, true) // isLoadingProgress=true, getCitations=true
    },
    pushGraph: function (newGraph) {
      this.graphs.push(newGraph)

      // Don't keep more articles in tab-bar than maxTabs
      if (this.graphs.length > this.maxTabs) this.graphs = this.graphs.slice(1)

      // Let user explore input articles while suggestions are still loading
      this.showArticlesTab = 'inputArticles'
      this.currentTabIndex = this.graphs.length - 1
      this.saveState()
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
      this.$buefy.dialog.prompt({
        message: (this.API === 'OpenAlex')
          ? 'Enter <a href="https://docs.openalex.org/about-the-data/work#ids" target="_blank">DOI / PMID / other ID</a> of new source article'
          : ((this.API === 'Semantic Scholar')
            ? 'Enter <a href="https://api.semanticscholar.org/graph/v1#operation/get_graph_get_paper_references" target="_blank">DOI / PMID / ARXIV / other ID</a> of new source article'
            : 'Enter <a href="https://en.wikipedia.org/wiki/Digital_object_identifier" target="_blank">DOI</a> of new source article'),
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
          this.selected.authors.map(x => x.id).forEach(author => {
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
      // Sort tables & select top article for tables
      this.currentGraph.input.sort(this.sortInDegree)
      this.selectedInputArticle = this.currentGraph.input[0]

      if (this.currentGraph.incomingSuggestions && this.currentGraph.incomingSuggestions.length) {
        this.currentGraph.incomingSuggestions.sort(this.sortInDegree)
        this.selectedIncomingSuggestionsArticle = this.currentGraph.incomingSuggestions[0]
        // Set maximum number of incoming suggestions if not set (compatibility with stored graphs (e.g. localStorage) with versions prior to 1.1)
        if (this.currentGraph.maxIncomingSuggestions === undefined) this.$set(this.currentGraph, 'maxIncomingSuggestions', Math.min(10, this.currentGraph.incomingSuggestions.length))
      }
      if (this.currentGraph.outgoingSuggestions && this.currentGraph.outgoingSuggestions.length) {
        this.currentGraph.outgoingSuggestions.sort(this.sortOutDegree)
        this.selectedOutgoingSuggestionsArticle = this.currentGraph.outgoingSuggestions[0]
        // Set maximum number of outgoing suggestions if not set (compatibility with stored graphs (e.g. localStorage) with versions prior to 1.1)
        if (this.currentGraph.maxOutgoingSuggestions === undefined) this.$set(this.currentGraph, 'maxOutgoingSuggestions', Math.min(10, this.currentGraph.outgoingSuggestions.length))
      }

      // Networks are handled by vis.js outside of Vue through these two global init function
      // Initializing both networks now incurs higher CPU usage now but then tab changes are quicker compared to init at watch:showAuthorNetwork (especially when going back and forth)
      initAuthorNetwork(this)
      initCitationNetwork(this)
    },
    inDegree: function (id) {
      return (this.currentGraph.referenced[id]) ? this.currentGraph.referenced[id].length : 0
    },
    outDegree: function (id) {
      return (this.currentGraph.citing[id]) ? this.currentGraph.citing[id].length : 0
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
    // Wrapper for Buefy tables with third argument "ascending"
    sortInDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortInDegree(b, a) : this.sortInDegree(a, b)
    },
    sortOutDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortOutDegree(b, a) : this.sortOutDegree(a, b)
    },
    callAPI: function (ids, response, API, isLoadingProgress = false, getCitations = false, getReferenceContexts = false) {
      if (API === 'OpenAlex') {
        return openAlexWrapper(ids, response, isLoadingProgress, getCitations && this.settings.getCitationsOA)
      } else if (API === 'Semantic Scholar') {
        return semanticScholarWrapper(ids, response, isLoadingProgress, getCitations, getReferenceContexts)
      } else if (API === 'OpenCitations') {
        return openCitationsWrapper(ids, response, isLoadingProgress)
      } else if (API === 'Crossref') {
        return crossrefWrapper(ids, response, isLoadingProgress)
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
    saveState: function () {
      if (this.autosaveResults) {
        const copiedGraphs = JSON.parse(JSON.stringify(this.graphs))
        localStorage.graphs = JSON.stringify(copiedGraphs.map(graph => {
          // Otherwise suggestions would be saved in loading state (undefined) but after reload they do not continue to load!
          if (graph.incomingSuggestions === undefined) graph.incomingSuggestions = []
          if (graph.outgoingSuggestions === undefined) graph.outgoingSuggestions = []
          return graph
        }))
        localStorage.settings = JSON.stringify(this.settings)
        localStorage.autosaveResults = true
        localStorage.API = this.API
      } else {
        localStorage.clear()
      }
    },
    filterArticles: function (articles) {
      const re = new RegExp(this.filterString, 'gi')
      switch (this.filterColumn) {
        case 'titleAbstract':
          return articles.filter(article => String(article.numberInSourceReferences).match(new RegExp(this.filterString, 'y')) || (article.title && article.title.match(re)) || (article.abstract && article.abstract.match(re)))
        case 'authors':
          return articles.filter(article => this.authorString(article.authors).match(re))
        case 'year':
          return articles.filter(article => String(article.year).match(re))
        case 'journal':
          return articles.filter(article => String(article.journal).match(re))
        default:
          return articles
      }
    },
    authorString: function (authors) {
      return (authors && authors.length) ? authors.map(x => ((x.FN) ? (x.FN) + ' ' : '') + x.LN).join(', ') : ''
    },
    authorStringShort: function (authors) {
      return (authors && authors.length > 5) ? this.authorString(authors.slice(0, 5).concat({ LN: '(' + (authors.length - 5) + ' more)' })) : this.authorString(authors)
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
    clickToggleAPI: function () {
      if (this.API === 'Crossref') {
        this.API = 'OpenAlex'
        this.$buefy.toast.open({
          message: 'Using OpenAlex (OA)',
          queue: false
        })
      } else if (this.API === 'OpenAlex') {
        this.API = 'Semantic Scholar'
        this.$buefy.toast.open({
          message: 'Using Semantic Scholar (S2)',
          queue: false
        })
      } else if (this.API === 'Semantic Scholar') {
        this.API = 'OpenCitations'
        this.$buefy.toast.open({
          message: 'Using OpenCitations (OC)',
          queue: false
        })
      } else {
        this.API = 'Crossref'
        this.$buefy.toast.open({
          message: 'Using Crossref (CR)',
          queue: false
        })
      }
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
      else if (this.currentGraph.API === 'OpenAlex') return 'https://openalex.org/' + article.id
      else if (this.currentGraph.API === 'Semantic Scholar') return 'https://semanticscholar.org/paper/' + article.id
      else return '#'
    },
    authorLink: function (author) {
      if (author.orcid) return 'https://orcid.org/' + author.orcid
      else if (Number(author.id.substr(1)) && this.currentGraph.API === 'OpenAlex') return 'https://openalex.org/' + author.id
      else if (Number(author.id) && this.currentGraph.API === 'Semantic Scholar') return 'https://semanticscholar.org/author/' + author.id
      else return 'https://scholar.google.com/scholar?q=' + author.name
    },
    changeCitationNetworkSettings: function () {
      initCitationNetwork(this)
      this.highlightNodes()
      this.saveState()
    },
    changeAuthorNetworkSettings: function () {
      initAuthorNetwork(this)
      this.highlightNodes()
      this.saveState()
    },
    downloadCSVData: function (table) {
      function prepareCell (text) {
        if (!text) return ''
        if (typeof (text) === 'object') text = text.join(', ')
        else text = String(text)
        while (text[0] === '=') text = text.substring(1)
        return text.replaceAll('"', '\"')
      }

      let csv = 'sep=;\n'
      csv += '"# https://timwoelfle.github.io/Local-Citation-Network/' + this.linkToShareAppendix + '"\n'
      csv += '"# Data retrieved through ' + this.currentGraph.API + ' (' + this.abbreviateAPI(this.currentGraph.API) + ') on ' + new Date(this.currentGraph.timestamp).toLocaleString() + '"\n'
      csv += '"id";"doi";' + ((this.showArticlesTab === 'inputArticles' && this.showNumberInSourceReferences) ? '"#";' : '') + '"title";"authors";"journal";"year";"abstract";"globalCitationsCount";"localInDegree";"localOutDegree";"referencesCount";"localIncomingCitations";"localOutgoingCitations";"references"\n'
      csv += table.map(row => {
        let arr = [row.id, row.doi, (this.showArticlesTab === 'inputArticles' && this.showNumberInSourceReferences) ? row.numberInSourceReferences : false, row.title, this.authorString(row.authors), row.journal, row.year, row.abstract, row.citationsCount, this.inDegree(row.id), this.outDegree(row.id), row.references.length, this.currentGraph.referenced[row.id], this.currentGraph.citing[row.id], row.references]
        arr = arr.filter(x => x !== false).map(x => prepareCell(x))
        return '"' + arr.join('";"') + '"'
      }).join('\n')

      const anchor = document.createElement('a')
      anchor.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
      anchor.target = '_blank'
      anchor.download = `${vm.currentGraph.tabLabel} ${vm.showArticlesTab}.csv`
      anchor.click()
      anchor.remove()
    },
    downloadJSON: function () {
      const anchor = document.createElement('a')
      anchor.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify([vm.currentGraph]))
      anchor.target = '_blank'
      anchor.download = `${vm.currentGraph.tabLabel}.json`
      anchor.click()
      anchor.remove()
    }
  },
  created: function () {
    const urlParams = new URLSearchParams(window.location.search)

    try {
      if (localStorage.graphs) this.graphs = JSON.parse(localStorage.graphs)
      if (localStorage.autosaveResults) this.autosaveResults = localStorage.autosaveResults
      if (localStorage.API && ['OpenAlex', 'Semantic Scholar', 'OpenCitations', 'Crossref'].includes(localStorage.API)) this.API = localStorage.API
      if (localStorage.settings) this.settings = JSON.parse(localStorage.settings)
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

      // Only if reference is not already open in a different tab with same API (setting to correct tab via this.currentTabIndex = X doesn't work because it is initialized to default afterwards)
      if (!(graphSourceIds.includes(id) && this.graphs[graphSourceIds.indexOf(id)].API === this.API)) {
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
