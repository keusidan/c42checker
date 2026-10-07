/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   main.c                                             :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/07 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/07 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void	keep(char **slot)
{
	*slot = malloc(16);
}

int	main(int argc, char **argv)
{
	char	*held;
	int		fd;

	(void)argv;
	held = NULL;
	keep(&held);
	if (argc > 100)
		free(held);
	fd = open("/dev/null", O_RDONLY);
	if (fd < 0)
		return (1);
	printf("leaking\n");
	return (0);
}
