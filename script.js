// ===========================
// Initialize AOS Animation
// ===========================
AOS.init({
    duration: 1000,
    once: true,
    offset: 100
});

// ===========================
// Mobile Navigation Toggle
// ===========================
const mobileToggle = document.querySelector('.mobile-toggle');
const navMenu = document.querySelector('.nav-menu');

if (mobileToggle) {
    mobileToggle.addEventListener('click', () => {
        navMenu.classList.toggle('active');
        mobileToggle.classList.toggle('active');
    });
}

// ===========================
// Smooth Scrolling
// ===========================
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            const offset = 80;
            const targetPosition = target.offsetTop - offset;

            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });

            // Close mobile menu if open
            navMenu.classList.remove('active');
            mobileToggle.classList.remove('active');
        }
    });
});

// ===========================
// Navbar Scroll Effect
// ===========================
const navbar = document.querySelector('.navbar');
let lastScroll = 0;

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;

    if (currentScroll > 100) {
        navbar.style.background = 'rgba(255, 255, 255, 0.98)';
        navbar.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
    } else {
        navbar.style.background = 'rgba(255, 255, 255, 0.95)';
        navbar.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
    }

    lastScroll = currentScroll;
});

// ===========================
// Active Navigation Link
// ===========================
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-link');

window.addEventListener('scroll', () => {
    let current = '';
    sections.forEach(section => {
        const sectionTop = section.offsetTop;

        if (window.pageYOffset >= sectionTop - 200) {
            current = section.getAttribute('id');
        }
    });

    navLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href').slice(1) === current) {
            link.classList.add('active');
        }
    });
});

// ===========================
// FAQ Accordion
// ===========================
const faqItems = document.querySelectorAll('.faq-item');

faqItems.forEach(item => {
    const question = item.querySelector('.faq-question');

    question.addEventListener('click', () => {
        faqItems.forEach(otherItem => {
            if (otherItem !== item && otherItem.classList.contains('active')) {
                otherItem.classList.remove('active');
            }
        });

        item.classList.toggle('active');
    });
});

// ===========================
// Pricing Tab Switcher
// ===========================
const tabBtns = document.querySelectorAll('.tab-btn');
const planCategories = document.querySelectorAll('.plan-category');

tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        planCategories.forEach(c => c.classList.remove('active'));

        btn.classList.add('active');

        const categoryMap = {
            'single': 'single-plans',
            'combo': 'combo-plans',
            'all': 'all-plans'
        };

        const category = btn.getAttribute('data-category');
        const targetCategory = document.getElementById(categoryMap[category]);
        if (targetCategory) {
            targetCategory.classList.add('active');
            // Re-init slider for newly visible category on mobile
            if (window.innerWidth <= 768) {
                // Use requestAnimationFrame to ensure the element is visible before measuring
                requestAnimationFrame(() => {
                    initSliderForGrid(targetCategory);
                    addSwipeSupport(targetCategory);
                    bindStripeLinks();
                });
            }
        }
    });
});

// ===========================
// Scroll to Top Button
// ===========================
const scrollTopBtn = document.createElement('div');
scrollTopBtn.className = 'scroll-top';
scrollTopBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
document.body.appendChild(scrollTopBtn);

window.addEventListener('scroll', () => {
    if (window.pageYOffset > 500) {
        scrollTopBtn.classList.add('show');
    } else {
        scrollTopBtn.classList.remove('show');
    }
});

scrollTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ===========================
// Parallax Effect for Hero
// ===========================
window.addEventListener('scroll', () => {
    const scrolled = window.pageYOffset;
    const parallaxElements = document.querySelectorAll('.circle-animation, .radar-animation');

    parallaxElements.forEach(element => {
        const speed = element.classList.contains('circle-animation') ? 0.5 : 0.3;
        element.style.transform = `translateY(${scrolled * speed}px)`;
    });
});

// ===========================
// Pricing Card Hover Effects
// ===========================
const pricingCards = document.querySelectorAll('.pricing-card');

pricingCards.forEach(card => {
    card.addEventListener('mouseenter', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        card.style.setProperty('--mouse-x', `${x}px`);
        card.style.setProperty('--mouse-y', `${y}px`);
    });
});

// ===========================
// Disclaimer Modal
// ===========================
let pendingStripeUrl = null;

const disclaimerModal = document.getElementById('disclaimerModal');
const agreeCheckbox = document.getElementById('agreeCheckbox');
const proceedBtn = document.getElementById('proceedBtn');
const cancelBtn = document.getElementById('cancelBtn');
const viewFullTerms = document.getElementById('viewFullTerms');

function openDisclaimerModal(stripeUrl) {
    pendingStripeUrl = stripeUrl;
    if (agreeCheckbox) agreeCheckbox.checked = false;
    if (proceedBtn) proceedBtn.disabled = true;
    if (disclaimerModal) disclaimerModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeDisclaimerModal() {
    if (disclaimerModal) disclaimerModal.classList.remove('active');
    document.body.style.overflow = '';
    pendingStripeUrl = null;
}

if (agreeCheckbox) {
    agreeCheckbox.addEventListener('change', () => {
        proceedBtn.disabled = !agreeCheckbox.checked;
    });
}

if (proceedBtn) {
    proceedBtn.addEventListener('click', () => {
        if (agreeCheckbox && agreeCheckbox.checked && pendingStripeUrl) {
            const url = pendingStripeUrl;
            closeDisclaimerModal();
            window.location.href = url;
        }
    });
}

if (cancelBtn) {
    cancelBtn.addEventListener('click', closeDisclaimerModal);
}

// Close modal if clicking backdrop
if (disclaimerModal) {
    disclaimerModal.addEventListener('click', (e) => {
        if (e.target === disclaimerModal) closeDisclaimerModal();
    });
}

if (viewFullTerms) {
    viewFullTerms.addEventListener('click', (e) => {
        e.preventDefault();
        window.open('terms.html', '_blank');
    });
}

// Intercept ALL Stripe buy links
function bindStripeLinks() {
    document.querySelectorAll('a[href*="buy.stripe.com"]').forEach(link => {
        // Remove any previous listener to avoid duplicates
        link.removeEventListener('click', stripeClickHandler);
        link.addEventListener('click', stripeClickHandler);
    });
}

function stripeClickHandler(e) {
    e.preventDefault();
    const stripeUrl = this.getAttribute('href');
    openDisclaimerModal(stripeUrl);
}

// ===========================
// Mobile Pricing Slider
// ===========================
const MOBILE_BREAKPOINT = 768;

function destroySlider(grid) {
    /**
     * Tear down an existing slider so it can be rebuilt cleanly.
     * Moves cards back out of the wrapper/track into the grid root.
     */
    const wrapper = grid.querySelector('.slider-wrapper');
    if (!wrapper) return;

    const track = wrapper.querySelector('.slider-track');
    if (track) {
        // Move cards back to the grid root
        const cards = Array.from(track.querySelectorAll(':scope > .pricing-card'));
        cards.forEach(card => {
            card.style.minHeight = '';
            card.classList.remove('slide-active');
            grid.appendChild(card);
        });
    }
    wrapper.remove();

    // Clean up data attributes
    delete grid.dataset.currentSlide;
    delete grid.dataset.totalSlides;
}

function initSliderForGrid(grid) {
    if (!grid) return;

    // Always rebuild fresh to avoid stale state
    destroySlider(grid);

    const cards = Array.from(grid.querySelectorAll(':scope > .pricing-card'));
    if (cards.length === 0) return;

    // Single card (All Markets): no slider needed, just bind links
    if (cards.length === 1) {
        cards[0].style.pointerEvents = 'auto';
        bindStripeLinks();
        return;
    }

    // Build wrapper > track structure
    const wrapper = document.createElement('div');
    wrapper.className = 'slider-wrapper';

    const track = document.createElement('div');
    track.className = 'slider-track';

    cards.forEach((card, i) => {
        card.classList.toggle('slide-active', i === 0);
        track.appendChild(card);
    });

    wrapper.appendChild(track);

    // Dots
    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'slider-dots';

    cards.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.className = 'slider-dot' + (i === 0 ? ' active' : '');
        dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
        dot.addEventListener('click', () => goToSlide(grid, i));
        dotsContainer.appendChild(dot);
    });

    wrapper.appendChild(dotsContainer);
    grid.appendChild(wrapper);

    // Store state
    grid.dataset.currentSlide = '0';
    grid.dataset.totalSlides = String(cards.length);

    // Equalise card heights after layout settles
    requestAnimationFrame(() => equaliseCardHeights(grid));

    bindStripeLinks();
}

function goToSlide(grid, index) {
    const track = grid.querySelector('.slider-track');
    const dots = grid.querySelectorAll('.slider-dot');
    const cards = grid.querySelectorAll('.slider-track .pricing-card');

    if (!track) return;

    const total = parseInt(grid.dataset.totalSlides || '0', 10);
    index = Math.max(0, Math.min(index, total - 1));

    track.style.transform = `translateX(-${index * 100}%)`;
    grid.dataset.currentSlide = String(index);

    cards.forEach((card, i) => {
        card.classList.toggle('slide-active', i === index);
    });

    dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });
}

function equaliseCardHeights(grid) {
    const cards = grid.querySelectorAll('.pricing-card');
    // Reset first
    cards.forEach(c => (c.style.minHeight = ''));
    // Measure
    let maxH = 0;
    cards.forEach(c => {
        maxH = Math.max(maxH, c.offsetHeight);
    });
    // Apply
    if (maxH > 0) {
        cards.forEach(c => (c.style.minHeight = maxH + 'px'));
    }
}

function initAllMobileSliders() {
    if (window.innerWidth > MOBILE_BREAKPOINT) return;

    document.querySelectorAll('.plan-category').forEach(grid => {
        // Only init the visible (active) one immediately; others init on tab click
        if (grid.classList.contains('active')) {
            initSliderForGrid(grid);
        }
    });
}

// Touch/swipe support
function addSwipeSupport(grid) {
    const wrapper = grid.querySelector('.slider-wrapper');
    if (!wrapper || wrapper.dataset.swipeInit) return;
    wrapper.dataset.swipeInit = 'true';

    let startX = 0;
    let isDragging = false;

    wrapper.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        isDragging = true;
    }, { passive: true });

    wrapper.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        const diff = startX - e.changedTouches[0].clientX;
        const total = parseInt(grid.dataset.totalSlides || '1', 10);
        const current = parseInt(grid.dataset.currentSlide || '0', 10);

        if (Math.abs(diff) > 50) {
            if (diff > 0 && current < total - 1) goToSlide(grid, current + 1);
            if (diff < 0 && current > 0) goToSlide(grid, current - 1);
        }
        isDragging = false;
    }, { passive: true });
}

// After sliders are inited, also add swipe
function postSliderInit() {
    document.querySelectorAll('.plan-category').forEach(grid => {
        addSwipeSupport(grid);
    });
}

// Re-init on resize (desktop ↔ mobile)
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (window.innerWidth <= MOBILE_BREAKPOINT) {
            initAllMobileSliders();
            postSliderInit();
        } else {
            // Desktop: destroy all sliders so cards go back to grid
            document.querySelectorAll('.plan-category').forEach(grid => {
                destroySlider(grid);
            });
        }
    }, 250);
});

// ===========================
// Initialize Everything on DOM Ready
// ===========================
document.addEventListener('DOMContentLoaded', () => {
    console.log('RHO Market Navigator loaded!');

    // Bind disclaimer to all desktop stripe links
    bindStripeLinks();

    // Mobile slider
    initAllMobileSliders();
    postSliderInit();

    // External links close mobile menu
    document.querySelectorAll('a[href^="http"]').forEach(link => {
        if (link.getAttribute('href').startsWith('#')) return;
        link.addEventListener('click', () => {
            if (navMenu && navMenu.classList.contains('active')) {
                navMenu.classList.remove('active');
                if (mobileToggle) mobileToggle.classList.remove('active');
            }
        });
    });

    if (typeof gtag !== 'undefined') {
        gtag('event', 'page_view', {
            page_title: document.title,
            page_location: window.location.href,
            page_path: window.location.pathname
        });
    }
});

// ===========================
// Performance Optimization
// ===========================
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => { clearTimeout(timeout); func(...args); };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const debouncedScroll = debounce(() => { }, 100);
window.addEventListener('scroll', debouncedScroll, { passive: true });