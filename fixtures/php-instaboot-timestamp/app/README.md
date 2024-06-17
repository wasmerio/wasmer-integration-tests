# php-instaboot-timestamp

Very simple PHP app that:

* stores the current timestamp in a file if the x-edge-instaboot header is present
* otherwise, tries to serve the contents of the file

Used for Instaboot testing (cache purging, max_age).
