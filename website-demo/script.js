// RHO Navigator prototype — interactions

// Tabbed showcase
document.querySelectorAll('.tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('on'); });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.remove('on'); });
    tab.classList.add('on');
    var pane = document.getElementById(tab.dataset.pane);
    if (pane) pane.classList.add('on');
  });
});

// Nav background on scroll
var nav = document.getElementById('nav');
function onScroll() {
  if (window.scrollY > 20) nav.classList.add('scrolled');
  else nav.classList.remove('scrolled');
}
window.addEventListener('scroll', onScroll);
onScroll();

// Mobile menu toggle (links list is hidden on small screens for now)
var toggle = document.getElementById('navToggle');
var links = document.querySelector('.nav-links');
if (toggle && links) {
  toggle.addEventListener('click', function () {
    var open = links.style.display === 'flex';
    links.style.display = open ? '' : 'flex';
    links.style.position = 'absolute';
    links.style.flexDirection = 'column';
    links.style.top = '68px';
    links.style.right = '22px';
    links.style.background = '#0c1422';
    links.style.padding = open ? '' : '1rem 1.4rem';
    links.style.borderRadius = '12px';
    links.style.border = open ? '' : '1px solid rgba(255,255,255,0.1)';
    links.style.gap = '1rem';
  });
}

// Pricing tabs
document.querySelectorAll('.ptab').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('.ptab').forEach(function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    document.querySelectorAll('.plans').forEach(function (p) { p.classList.remove('on'); });
    var grid = document.querySelector('.plans[data-cat="' + b.dataset.cat + '"]');
    if (grid) grid.classList.add('on');
  });
});

// FAQ accordion
document.querySelectorAll('.faq-q').forEach(function (q) {
  q.addEventListener('click', function () {
    q.parentElement.classList.toggle('open');
  });
});

// Play overlay — placeholder until the real demo video is recorded
var play = document.getElementById('playOverlay');
if (play) {
  play.addEventListener('click', function () {
    alert('This is where your 60-second screen recording of the live Navigator will play.');
  });
}
