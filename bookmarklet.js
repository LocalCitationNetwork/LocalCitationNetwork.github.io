javascript:(function(){
    // root DOI has to be identified to remove it from list later
    rootDOI = document.querySelector('meta[name=\'citation_doi\']') || document.querySelector('meta[name=\'evt-doiPage\']') || document.querySelector('meta[name=\'dc.Identifier\']');
    if (!rootDOI) return(alert('Unfortunately could not extract references.'));
    else rootDOI = rootDOI.content.toUpperCase();
    
    // onlinelibrary.wiley.com
    lis = document.querySelectorAll('#references-section ul > li');
    // nature.com
    if (!lis.length) lis = document.querySelectorAll('ol.c-article-references > li');
    // pnas.org / sciencemag.org / jimmunol.org / biorxiv.org
    if (!lis.length) lis = document.querySelectorAll('ol.cit-list > li');
    // frontiersin.org
    if (!lis.length) lis = document.querySelectorAll('div.References');
    // nejm.org
    if (!lis.length) lis = document.querySelectorAll('ol#referenceContent > li');
    // amjpathol.org
    if (!lis.length) lis = document.querySelectorAll('ol.referenceList > li');
    // oup.com
    if (!lis.length) lis = document.querySelectorAll('.ref-list .ref');
    // plos.org
    if (!lis.length) lis = document.querySelectorAll('.references > li');
    // cell.com / thelancet.com
    if (!lis.length) lis = document.querySelectorAll('li.ref');
    // sagepub.com
    if (!lis.length) lis = document.querySelectorAll('table.references tr');

    listOfReferenceDOIs = Array.from(lis).map(x => {
        // Regular expression adapted from Crossref's recommendation (https://www.crossref.org/blog/dois-and-matching-regular-expressions/)
        // Using the set [-_;()/:A-Z0-9] twice (fullstop . and semicolon ; only in first set) makes sure that the trailing character is neither a fullstop nor semicolon
        x = decodeURIComponent(x.innerHTML).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+[-_()/:A-Z0-9]+/gi);
        // Make sure DOIs fetched in the reference list are not the root article's DOI
        return(x && x.map(y => y.toUpperCase()).filter(y => y !== rootDOI)[0]);
    });
    
    if (listOfReferenceDOIs.length) {
        window.open('https://timwoelfle.github.io/Local-Citation-Network/index.html?name=Custom&editList=true&listOfDOIs=' + listOfReferenceDOIs.join(','));
    } else {
        alert('Unfortunately could not extract references.');
    }
}())
